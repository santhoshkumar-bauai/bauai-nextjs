import { isValidObjectId } from "mongoose";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { onlyOfficeDocumentKey } from "@/lib/onlyoffice/key";
import { serializeWorkspaceDocument } from "@/lib/onlyoffice/serialize";
import { workspaceVersionKey } from "@/lib/onlyoffice/storage";
import { copyObject, deleteObject, s3Config } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

type RouteContext = { params: Promise<{ documentId: string; versionId: string }> };

export async function POST(_request: Request, { params }: RouteContext) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { documentId, versionId } = await params;
  if (!isValidObjectId(documentId) || !isValidObjectId(versionId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const [document, source] = await Promise.all([
    WorkspaceDocument.findOne({
      _id: documentId,
      companyId: context.company._id,
      deletedAt: null,
    }),
    WorkspaceDocumentVersion.findOne({
      _id: versionId,
      documentId,
      companyId: context.company._id,
      state: "committed",
    }).lean(),
  ]);
  if (!document || !source) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (document.activeUserIds.length > 0) {
    return NextResponse.json({ error: "document_is_being_edited" }, { status: 409 });
  }
  if (source.extension !== document.extension) {
    return NextResponse.json({ error: "legacy_version_cannot_be_restored" }, { status: 409 });
  }

  const storageRevision = document.storageRevision + 1;
  const editorRevision = document.editorRevision + 1;
  const targetKey = workspaceVersionKey({
    companyId: context.company.id,
    documentId,
    storageRevision,
    extension: document.extension,
  });
  try {
    await copyObject({
      sourceBucket: source.s3Bucket,
      sourceKey: source.s3Key,
      targetKey,
      contentType: source.contentType,
    });
    const version = await WorkspaceDocumentVersion.create({
      companyId: document.companyId,
      documentId: document._id,
      storageRevision,
      editorRevision,
      reason: "restore",
      state: "committed",
      s3Bucket: s3Config().bucket,
      s3Key: targetKey,
      fileName: document.fileName,
      extension: document.extension,
      contentType: document.contentType,
      size: source.size,
      sha256: source.sha256,
      createdBy: context.userId,
    });
    const updated = await WorkspaceDocument.findOneAndUpdate(
      {
        _id: document._id,
        companyId: context.company._id,
        storageRevision: document.storageRevision,
        editorRevision: document.editorRevision,
        activeUserIds: { $size: 0 },
      },
      {
        $set: {
          storageRevision,
          editorRevision,
          activeEditorKey: onlyOfficeDocumentKey({ documentId, editorRevision }),
          currentVersionId: version._id,
          state: "ready",
          stateError: null,
          updatedBy: context.userId,
        },
      },
      { new: true },
    );
    if (!updated) {
      await WorkspaceDocumentVersion.updateOne({ _id: version._id }, { state: "orphan" });
      throw new Error("Document changed while restoring");
    }
    return NextResponse.json({ document: serializeWorkspaceDocument(updated) });
  } catch (error) {
    await deleteObject(targetKey).catch(() => undefined);
    console.error("Version restore failed", error);
    return NextResponse.json({ error: "restore_failed" }, { status: 409 });
  }
}
