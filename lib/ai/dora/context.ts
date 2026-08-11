import { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { connectMongoose } from "../../db/mongoose.ts";
import {
  WorkspaceDocument,
  type WorkspaceDocumentType,
} from "../../../models/workspace-document.ts";
import { WorkspaceDocumentVersion } from "../../../models/workspace-document-version.ts";
import { CitationCollector } from "../agent/citations.ts";
import {
  resolveVisibleTender,
  type AgentRunContext,
} from "../agent/context.ts";
import { TenderRefCollector } from "../agent/tender-refs.ts";
import { forCompanyContext } from "../tenant/repository.ts";

/**
 * Dora's run context: Clara's AgentRunContext plus the ONE workspace document
 * the run is bound to. Built SERVER-SIDE from the authenticated request —
 * tools close over it, and neither tenant nor document ids are ever tool
 * inputs. When the document is a tender working copy, `tender` is resolved so
 * every Clara tender renderer works unchanged; for direct uploads it is null
 * and the tender tools are simply not registered.
 */

export interface DoraDocumentScope {
  documentId: ObjectId;
  fileName: string;
  extension: string;
  contentType: string;
  documentType: WorkspaceDocumentType;
  state: string;
  storageRevision: number;
  activeEditorKey: string;
  activeUserIds: string[];
  /** The current committed version; null while uploading/converting. */
  version: {
    id: ObjectId;
    sha256: string;
    s3Key: string;
    fileName: string;
    extension: string;
    contentType: string;
    storageRevision: number;
    reason: string;
  } | null;
}

export interface DoraRunContext extends AgentRunContext {
  document: DoraDocumentScope;
}

/** Ownership filter identical to the workspace-document routes. */
export async function buildDoraRunContext(input: {
  companyContext: CompanyContext;
  documentIdHex: string;
  locale: "en" | "de";
}): Promise<DoraRunContext | null> {
  if (!ObjectId.isValid(input.documentIdHex)) return null;
  await connectMongoose();

  const document = await WorkspaceDocument.findOne({
    _id: input.documentIdHex,
    companyId: input.companyContext.company._id,
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

  // A hidden/removed tender degrades to an unlinked document, not an error.
  const tenderIdHex = document.tenderId ? String(document.tenderId) : null;
  const tender = tenderIdHex ? await resolveVisibleTender(tenderIdHex) : null;

  return {
    tenantId: forCompanyContext(input.companyContext).value,
    userId: input.companyContext.userId,
    locale: input.locale,
    companyContext: input.companyContext,
    citations: new CitationCollector(),
    tenderRefs: new TenderRefCollector(),
    tender,
    tenderCache: new Map(tenderIdHex ? [[tenderIdHex, tender]] : []),
    document: {
      documentId: new ObjectId(String(document._id)),
      fileName: document.fileName,
      extension: document.extension,
      contentType: document.contentType,
      documentType: document.documentType,
      state: document.state,
      storageRevision: document.storageRevision,
      activeEditorKey: document.activeEditorKey,
      activeUserIds: document.activeUserIds ?? [],
      version: version
        ? {
            id: new ObjectId(String(version._id)),
            sha256: version.sha256,
            s3Key: version.s3Key,
            fileName: version.fileName,
            extension: version.extension,
            contentType: version.contentType,
            storageRevision: version.storageRevision,
            reason: version.reason,
          }
        : null,
    },
  };
}
