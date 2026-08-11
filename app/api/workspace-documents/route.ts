import { NextResponse } from "next/server";
import { isValidObjectId } from "mongoose";

import { getCompanyContext } from "@/lib/company/context";
import { createWorkspaceDocumentFromObject } from "@/lib/onlyoffice/document-service";
import { onlyOfficeEnabled } from "@/lib/onlyoffice/env";
import { workspaceFormat } from "@/lib/onlyoffice/formats";
import { serializeWorkspaceDocument } from "@/lib/onlyoffice/serialize";
import { hashStoredObject } from "@/lib/onlyoffice/storage";
import { verifyUploadToken } from "@/lib/onlyoffice/tokens";
import { headObject } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";

export async function GET(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 25));
  const tenderId = url.searchParams.get("tenderId");
  const filter: Record<string, unknown> = {
    companyId: context.company._id,
    deletedAt: null,
  };
  if (tenderId) {
    if (!isValidObjectId(tenderId)) {
      return NextResponse.json({ error: "Invalid tender filter." }, { status: 400 });
    }
    filter.tenderId = tenderId;
  }
  const [items, total] = await Promise.all([
    WorkspaceDocument.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    WorkspaceDocument.countDocuments(filter),
  ]);
  return NextResponse.json({
    items: items.map(serializeWorkspaceDocument),
    page,
    limit,
    total,
  });
}

export async function POST(request: Request) {
  if (!onlyOfficeEnabled()) {
    return NextResponse.json({ error: "ONLYOFFICE is disabled." }, { status: 503 });
  }
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let token = "";
  try {
    const body = (await request.json()) as { uploadToken?: unknown };
    token = typeof body.uploadToken === "string" ? body.uploadToken : "";
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const claims = await verifyUploadToken(token);
    if (claims.companyId !== context.company.id || claims.userId !== context.userId) {
      return NextResponse.json({ error: "Upload does not belong to this company." }, { status: 403 });
    }
    const format = workspaceFormat(claims.fileName);
    if (!format) return NextResponse.json({ error: "unsupported_file_type" }, { status: 400 });
    const head = await headObject(claims.key);
    if (!head) return NextResponse.json({ error: "upload_not_found" }, { status: 409 });
    if (head.contentLength !== claims.size) {
      return NextResponse.json({ error: "upload_size_mismatch" }, { status: 409 });
    }
    const hashed = await hashStoredObject(claims.key);
    const document = await createWorkspaceDocumentFromObject({
      companyId: context.company._id,
      source: { kind: "upload" },
      fileName: claims.fileName,
      format,
      contentType: claims.contentType,
      size: hashed.size,
      sha256: hashed.sha256,
      sourceKey: claims.key,
      actorId: context.userId,
    });
    if (format.requiresConversion) {
      try {
        const { enqueueOnlyOfficeConversion } = await import("@/lib/onlyoffice/queue");
        await enqueueOnlyOfficeConversion(String(document._id));
      } catch (error) {
        console.error("Failed to enqueue ONLYOFFICE conversion", error);
        document.state = "conversion_failed";
        document.stateError = "conversion_queue_unavailable";
        await document.save();
      }
    }
    return NextResponse.json(
      { document: serializeWorkspaceDocument(document) },
      { status: 201 },
    );
  } catch (error) {
    console.error("Failed to confirm workspace document upload", error);
    return NextResponse.json({ error: "upload_confirmation_failed" }, { status: 400 });
  }
}
