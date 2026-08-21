import { randomUUID } from "node:crypto";

import type { Types } from "mongoose";

import { deleteObject, s3Config } from "@/lib/storage/s3";
import { WorkspaceDocument, type WorkspaceDocumentSource } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";
import type { WorkspaceVersionReason } from "@/models/workspace-document-version";

import type { WorkspaceFormat } from "./formats";
import { onlyOfficeDocumentKey } from "./key";
import { promotePendingObject, workspaceVersionKey } from "./storage";

export async function createWorkspaceDocumentFromObject(input: {
  companyId: Types.ObjectId;
  tenderId?: Types.ObjectId | null;
  source: WorkspaceDocumentSource;
  fileName: string;
  format: WorkspaceFormat;
  contentType: string;
  size: number;
  sha256: string;
  sourceKey: string;
  sourceBucket?: string;
  actorId: string;
  versionReason?: WorkspaceVersionReason;
}) {
  const document = new WorkspaceDocument({
    companyId: input.companyId,
    tenderId: input.tenderId ?? null,
    source: input.source,
    fileName: input.fileName,
    extension: input.format.extension,
    contentType: input.contentType || input.format.contentType,
    documentType: input.format.documentType,
    state: input.format.requiresConversion ? "converting" : "ready",
    editorRevision: 1,
    storageRevision: 0,
    activeEditorKey: "pending",
    activeUserIds: [],
    createdBy: input.actorId,
    updatedBy: input.actorId,
  });
  document.activeEditorKey = onlyOfficeDocumentKey({
    documentId: String(document._id),
    editorRevision: 1,
  });
  await document.save();

  const finalKey = workspaceVersionKey({
    companyId: String(input.companyId),
    documentId: String(document._id),
    storageRevision: 1,
    extension: input.format.extension,
  });

  try {
    await promotePendingObject({
      pendingKey: input.sourceKey,
      finalKey,
      contentType: input.contentType || input.format.contentType,
      sourceBucket: input.sourceBucket,
    });
    const version = await WorkspaceDocumentVersion.create({
      companyId: input.companyId,
      documentId: document._id,
      storageRevision: 1,
      editorRevision: 1,
      reason: input.versionReason ?? "upload",
      state: "committed",
      s3Bucket: s3Config().bucket,
      s3Key: finalKey,
      fileName: input.fileName,
      extension: input.format.extension,
      contentType: input.contentType || input.format.contentType,
      size: input.size,
      sha256: input.sha256,
      createdBy: input.actorId,
    });
    document.storageRevision = 1;
    document.currentVersionId = version._id;
    await document.save();
    return document;
  } catch (error) {
    await Promise.allSettled([
      WorkspaceDocumentVersion.deleteMany({ documentId: document._id }),
      WorkspaceDocument.deleteOne({ _id: document._id }),
      deleteObject(finalKey),
    ]);
    throw error;
  }
}

export function conversionJobId(documentId: string): string {
  return `onlyoffice-convert-${documentId}-${randomUUID()}`;
}
