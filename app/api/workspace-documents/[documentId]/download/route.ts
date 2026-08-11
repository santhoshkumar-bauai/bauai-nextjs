import { isValidObjectId } from "mongoose";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { createDownloadUrl } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    companyId: context.company._id,
    deletedAt: null,
  }).lean();
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const requestedVersion = new URL(request.url).searchParams.get("versionId");
  const versionId = requestedVersion || (document.currentVersionId && String(document.currentVersionId));
  if (!versionId || !isValidObjectId(versionId)) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }
  const version = await WorkspaceDocumentVersion.findOne({
    _id: versionId,
    documentId: document._id,
    companyId: context.company._id,
    state: "committed",
  }).lean();
  if (!version) return NextResponse.json({ error: "Version not found" }, { status: 404 });
  const result = await createDownloadUrl({
    key: version.s3Key,
    fileName: document.fileName,
    disposition: "attachment",
  });
  return NextResponse.json({ downloadUrl: result.downloadUrl, expiresIn: result.expiresIn });
}
