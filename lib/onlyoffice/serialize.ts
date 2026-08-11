import type { HydratedDocument } from "mongoose";

import type { WorkspaceDocumentDocument } from "@/models/workspace-document";
import type { WorkspaceDocumentVersionDocument } from "@/models/workspace-document-version";

export function serializeWorkspaceDocument(
  document: HydratedDocument<WorkspaceDocumentDocument> | (WorkspaceDocumentDocument & { _id: unknown }),
) {
  return {
    id: String(document._id),
    companyId: String(document.companyId),
    tenderId: document.tenderId ? String(document.tenderId) : null,
    fileName: document.fileName,
    extension: document.extension,
    contentType: document.contentType,
    documentType: document.documentType,
    state: document.state,
    stateError: document.stateError ?? null,
    currentVersionId: document.currentVersionId ? String(document.currentVersionId) : null,
    editorRevision: document.editorRevision,
    storageRevision: document.storageRevision,
    activeUsers: document.activeUserIds.length,
    createdAt: document.createdAt?.toISOString() ?? null,
    updatedAt: document.updatedAt?.toISOString() ?? null,
  };
}

export type SerializedWorkspaceDocument = ReturnType<typeof serializeWorkspaceDocument>;
export type SerializedWorkspaceVersion = ReturnType<typeof serializeWorkspaceVersion>;

export function serializeWorkspaceVersion(
  version: HydratedDocument<WorkspaceDocumentVersionDocument> | (WorkspaceDocumentVersionDocument & { _id: unknown }),
) {
  return {
    id: String(version._id),
    storageRevision: version.storageRevision,
    editorRevision: version.editorRevision,
    reason: version.reason,
    state: version.state,
    fileName: version.fileName,
    size: version.size,
    sha256: version.sha256,
    createdBy: version.createdBy,
    createdAt: version.createdAt?.toISOString() ?? null,
  };
}
