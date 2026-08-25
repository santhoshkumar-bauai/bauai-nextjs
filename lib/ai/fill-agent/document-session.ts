import { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { connectMongoose } from "../../db/mongoose.ts";
import { getObjectBuffer } from "../../storage/s3.ts";
import { WorkspaceDocument } from "../../../models/workspace-document.ts";
import { WorkspaceDocumentVersion } from "../../../models/workspace-document-version.ts";
import { buildPdfManifest } from "../dora/fill/pdf/manifest.ts";
import { forCompanyContext } from "../tenant/repository.ts";
import { fillAgentEnv } from "./env.ts";
import {
  createFillSession,
  getFillSessionCollection,
  updateFillSession,
  type FillAgentSessionDocument,
} from "./store.ts";
import { ensureFillSessionThread } from "./threads.ts";

/**
 * The document-filler entry point: one fill session per workspace document,
 * created lazily from the document's current committed version. The session's
 * source REFERENCES the version's S3 object (no copy) — teardown knows not to
 * delete document-bound sources.
 *
 * Returns an error code instead of throwing for the states the chooser UI
 * must explain (not a PDF, scanned, still converting).
 */
export async function ensureDocumentFillSession(input: {
  companyContext: CompanyContext;
  documentIdHex: string;
}): Promise<
  | { session: FillAgentSessionDocument }
  | { error: "not_found" | "not_pdf" | "no_version" | "scanned_pdf" | "pdf_unreadable" | "too_many_pages" }
> {
  if (!ObjectId.isValid(input.documentIdHex)) return { error: "not_found" };
  await connectMongoose();

  const document = await WorkspaceDocument.findOne({
    _id: input.documentIdHex,
    companyId: input.companyContext.company._id,
    deletedAt: null,
  }).lean();
  if (!document) return { error: "not_found" };
  if (document.documentType !== "pdf") return { error: "not_pdf" };

  const tenantId = forCompanyContext(input.companyContext).value;
  const documentId = new ObjectId(String(document._id));

  const collection = await getFillSessionCollection();
  const existing = await collection.findOne({ tenantId, documentId });

  const version = document.currentVersionId
    ? await WorkspaceDocumentVersion.findOne({
        _id: document.currentVersionId,
        documentId: document._id,
        state: "committed",
      }).lean()
    : null;
  if (!version) {
    if (existing) return { session: existing };
    return { error: "no_version" };
  }

  // Reuse while the session still matches the document's current bytes; a
  // new version (re-upload, editor save) starts a fresh session so the
  // fieldmap can never silently target stale geometry.
  if (existing && existing.source.sha256 === version.sha256) {
    return { session: existing };
  }

  const env = fillAgentEnv();
  const bytes = await getObjectBuffer(version.s3Key);
  let manifest;
  try {
    manifest = await buildPdfManifest(bytes);
  } catch {
    return { error: "pdf_unreadable" };
  }
  if (manifest.classification.pageCount > env.maxPages) return { error: "too_many_pages" };
  if (manifest.classification.documentClass === "scanned") return { error: "scanned_pdf" };

  const session = await createFillSession({
    tenantId,
    createdBy: input.companyContext.userId,
    documentId,
    source: {
      s3Key: version.s3Key,
      fileName: version.fileName,
      sha256: version.sha256,
      sizeBytes: version.size,
    },
    pdf: {
      documentClass: manifest.classification.documentClass,
      pageCount: manifest.classification.pageCount,
      manifestHash: manifest.manifestHash,
      acroFieldCount: manifest.classification.acroFieldCount,
    },
    maxFillIterations: env.fillBudget,
    targetScore: env.targetScore,
  });
  const thread = await ensureFillSessionThread({
    tenantId,
    sessionId: session._id!,
    userId: input.companyContext.userId,
  });
  const updated = await updateFillSession(tenantId, session._id!, {
    threadId: thread._id ?? null,
  });
  return { session: updated ?? session };
}
