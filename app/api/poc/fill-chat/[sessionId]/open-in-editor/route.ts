import { createHash } from "node:crypto";

import { Types } from "mongoose";
import { NextResponse } from "next/server";

import { buildFillAgentRunContext } from "@/lib/ai/fill-agent/context";
import { SandboxUnavailableError } from "@/lib/ai/fill-agent/sandbox-client";
import { getCompanyContext } from "@/lib/company/context";
import { connectMongoose } from "@/lib/db/mongoose";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { createWorkspaceDocumentFromObject } from "@/lib/onlyoffice/document-service";
import { workspaceFormat } from "@/lib/onlyoffice/formats";
import { workspacePendingKey } from "@/lib/onlyoffice/storage";
import { putObjectBuffer, sanitizeFileName } from "@/lib/storage/s3";

/**
 * "Open in ONLYOFFICE": materialize the CURRENT fill state (same
 * deterministic replay as the export route) as a new `generated-fill`
 * workspace document and hand its id back — the client navigates to
 * /document-filler/{id}?mode=editor. Works for partial fills too; the user
 * finishes by hand in the editor.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId } = await params;
  const ctx = await buildFillAgentRunContext({
    companyContext: context,
    sessionIdHex: sessionId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (ctx.session.fieldmap.length === 0) {
    return NextResponse.json({ error: "no_fieldmap" }, { status: 409 });
  }

  try {
    const workspaceId = await ctx.ensureSandbox();
    await ctx.sandbox.uploadFile(
      workspaceId,
      "fieldmap.json",
      Buffer.from(JSON.stringify({ fields: ctx.session.fieldmap })),
    );
    await ctx.sandbox.runPrepare(workspaceId);
    await ctx.sandbox.runFill(workspaceId);
    const bytes = await ctx.sandbox.downloadFile(workspaceId, "filled.pdf");

    const fileName = sanitizeFileName(`filled-${ctx.session.source.fileName}`);
    const format = workspaceFormat(fileName);
    if (!format) return NextResponse.json({ error: "unsupported_format" }, { status: 500 });

    await connectMongoose();
    const companyId = new Types.ObjectId(String(context.company._id));
    const pendingKey = workspacePendingKey(String(companyId), sessionId);
    await putObjectBuffer(pendingKey, bytes, "application/pdf");

    const document = await createWorkspaceDocumentFromObject({
      companyId,
      tenderId: null,
      source: {
        kind: "generated-fill",
        ...(ctx.session.documentId
          ? { sourceDocumentId: new Types.ObjectId(String(ctx.session.documentId)) }
          : {}),
      },
      fileName,
      format,
      contentType: "application/pdf",
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sourceKey: pendingKey,
      actorId: ctx.userId,
      versionReason: "generated_fill",
    });

    return NextResponse.json({ documentId: String(document._id) });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return NextResponse.json({ error: "sandbox_unavailable" }, { status: 503 });
    }
    throw error;
  }
}
