import { ObjectId } from "mongodb";

import type { CompanyContext } from "@/lib/company/context";
import { connectMongoose } from "@/lib/db/mongoose";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

/**
 * Ownership-checked scope for the GAEB routes: the workspace document plus
 * its committed version, without Clara's agent collectors. Mirrors the
 * lookup in lib/ai/dora/context.ts.
 */

export interface GaebRouteScope {
  tenantId: ObjectId;
  userId: string;
  documentId: ObjectId;
  fileName: string;
  extension: string;
  documentType: string;
  state: string;
  storageRevision: number;
  version: {
    id: ObjectId;
    sha256: string;
    s3Key: string;
    extension: string;
    storageRevision: number;
    size: number;
  } | null;
}

export async function loadGaebRouteScope(
  context: CompanyContext,
  documentIdHex: string,
): Promise<GaebRouteScope | null> {
  if (!ObjectId.isValid(documentIdHex)) return null;
  await connectMongoose();

  const document = await WorkspaceDocument.findOne({
    _id: documentIdHex,
    companyId: context.company._id,
    deletedAt: null,
  }).lean();
  if (!document) return null;

  const version = document.currentVersionId
    ? await WorkspaceDocumentVersion.findOne({
        _id: document.currentVersionId,
        documentId: document._id,
        state: "committed",
      }).lean()
    : null;

  return {
    tenantId: forCompanyContext(context).value,
    userId: context.userId,
    documentId: new ObjectId(String(document._id)),
    fileName: document.fileName,
    extension: document.extension,
    documentType: document.documentType,
    state: document.state,
    storageRevision: document.storageRevision,
    version: version
      ? {
          id: new ObjectId(String(version._id)),
          sha256: version.sha256,
          s3Key: version.s3Key,
          extension: version.extension,
          storageRevision: version.storageRevision,
          size: version.size,
        }
      : null,
  };
}
