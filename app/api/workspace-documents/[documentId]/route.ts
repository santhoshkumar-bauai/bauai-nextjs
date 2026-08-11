import { isValidObjectId } from "mongoose";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { serializeWorkspaceDocument } from "@/lib/onlyoffice/serialize";
import { deleteObject } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

type RouteContext = { params: Promise<{ documentId: string }> };

export async function GET(_request: Request, { params }: RouteContext) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    companyId: context.company._id,
    deletedAt: null,
  });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ document: serializeWorkspaceDocument(document) });
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const body = (await request.json().catch(() => null)) as { fileName?: unknown } | null;
  const requested = typeof body?.fileName === "string" ? body.fileName.trim() : "";
  if (!requested || requested.length > 160 || /[\\/]/.test(requested)) {
    return NextResponse.json({ error: "Invalid file name." }, { status: 400 });
  }
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    companyId: context.company._id,
    deletedAt: null,
  });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const suffix = `.${document.extension}`;
  document.fileName = requested.toLowerCase().endsWith(suffix)
    ? requested
    : `${requested}${suffix}`;
  document.updatedBy = context.userId;
  await document.save();
  return NextResponse.json({ document: serializeWorkspaceDocument(document) });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const context = await getCompanyContext({ requireAdmin: true });
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { documentId } = await params;
  if (!isValidObjectId(documentId)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const document = await WorkspaceDocument.findOne({
    _id: documentId,
    companyId: context.company._id,
    deletedAt: null,
  });
  if (!document) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (document.activeUserIds.length > 0) {
    return NextResponse.json({ error: "document_is_being_edited" }, { status: 409 });
  }
  document.state = "deleting";
  await document.save();
  const versions = await WorkspaceDocumentVersion.find({ documentId: document._id }).lean();
  try {
    await Promise.all(versions.map((version) => deleteObject(version.s3Key)));
    await WorkspaceDocumentVersion.deleteMany({ documentId: document._id });
    await document.deleteOne();
    return NextResponse.json({ ok: true, id: documentId });
  } catch (error) {
    document.state = "ready";
    document.stateError = "delete_failed";
    await document.save();
    console.error("Workspace document deletion failed", error);
    return NextResponse.json({ error: "delete_failed" }, { status: 502 });
  }
}
