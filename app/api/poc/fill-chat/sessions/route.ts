import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { buildPdfManifest } from "@/lib/ai/dora/fill/pdf/manifest";
import { fillAgentEnv } from "@/lib/ai/fill-agent/env";
import {
  createFillSession,
  listFillSessions,
  serializeFillSession,
  updateFillSession,
} from "@/lib/ai/fill-agent/store";
import { ensureFillSessionThread } from "@/lib/ai/fill-agent/threads";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";
import { buildObjectKey, putObjectBuffer, sanitizeFileName } from "@/lib/storage/s3";

/**
 * Fill-agent POC sessions. POST accepts a direct multipart upload (POC
 * simplification — the presigned-PUT + confirm flow is the promotion step),
 * gates it with the Node-side manifest (scanned PDFs are refused before any
 * storage or sandbox work), stores the bytes in S3 and creates the session.
 */

export async function GET() {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const tenantId = forCompanyContext(context).value;
  const sessions = await listFillSessions(tenantId);
  return NextResponse.json({ sessions: sessions.map(serializeFillSession) });
}

export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const env = fillAgentEnv();
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "file_missing" }, { status: 400 });
  }
  if (file.size > env.maxUploadBytes) {
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!bytes.subarray(0, 1024).toString("latin1").includes("%PDF-")) {
    return NextResponse.json({ error: "not_a_pdf" }, { status: 415 });
  }

  let manifest;
  try {
    manifest = await buildPdfManifest(bytes);
  } catch (error) {
    const code = error instanceof Error ? error.message : "pdf_unreadable";
    return NextResponse.json(
      { error: code === "pdf_encrypted" || code === "pdf_too_large" ? code : "pdf_unreadable" },
      { status: 422 },
    );
  }
  const { classification } = manifest;
  if (classification.pageCount > env.maxPages) {
    return NextResponse.json(
      { error: "too_many_pages", maxPages: env.maxPages },
      { status: 422 },
    );
  }
  if (classification.documentClass === "scanned") {
    // The Python POC's verify gate: no text layer means no geometry to
    // anchor a fill against. Refuse up front rather than mid-conversation.
    return NextResponse.json({ error: "scanned_pdf" }, { status: 422 });
  }

  const fileName = sanitizeFileName(file.name || "form.pdf");
  const s3Key = buildObjectKey({
    companyId: String(context.company._id),
    category: "fill-agent-poc",
    fileName,
    uniqueId: randomUUID(),
  });
  await putObjectBuffer(s3Key, bytes, "application/pdf");

  const tenantId = forCompanyContext(context).value;
  const session = await createFillSession({
    tenantId,
    createdBy: context.userId,
    source: {
      s3Key,
      fileName,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    },
    pdf: {
      documentClass: classification.documentClass,
      pageCount: classification.pageCount,
      manifestHash: manifest.manifestHash,
      acroFieldCount: classification.acroFieldCount,
    },
    maxFillIterations: env.fillBudget,
    targetScore: env.targetScore,
  });

  const thread = await ensureFillSessionThread({
    tenantId,
    sessionId: session._id!,
    userId: context.userId,
  });
  const updated = await updateFillSession(tenantId, session._id!, {
    threadId: thread._id ?? null,
  });

  return NextResponse.json(
    { session: serializeFillSession(updated ?? session) },
    { status: 201 },
  );
}
