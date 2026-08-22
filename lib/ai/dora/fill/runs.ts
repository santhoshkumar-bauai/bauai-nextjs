import { ObjectId } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";

import { fillRunFormat } from "./format";
import { canAutoApply } from "./locators";
import type {
  DocumentFillField,
  DocumentFillFormat,
  DocumentFillRunDocument,
} from "./types";

export function serializeFillRun(run: DocumentFillRunDocument) {
  return {
    id: run._id.toHexString(),
    documentId: run.documentId.toHexString(),
    format: fillRunFormat(run),
    sourceVersionId: run.sourceVersionId.toHexString(),
    sourceStorageRevision: run.sourceStorageRevision,
    status: run.status,
    stage: run.stage,
    fields: run.fields,
    // Page geometry rides out so the panel can convert a locator rect to
    // editor coordinates without ever re-parsing the PDF client-side.
    pdf: run.pdf ?? null,
    generatedDocumentId: run.generatedDocumentId?.toHexString() ?? null,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

export async function latestFillRun(tenantId: ObjectId, documentId: ObjectId) {
  const { documentFillRuns } = await getAiCollections();
  return documentFillRuns.findOne({ tenantId, documentId }, { sort: { createdAt: -1 } });
}

export async function createFillRun(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  format: DocumentFillFormat;
  sourceVersionId: ObjectId;
  sourceStorageRevision: number;
  sourceSha256: string;
  /** Word pins a live editor snapshot; PDF pins the committed bytes instead. */
  snapshotId: string | null;
  snapshotHash: string | null;
  userId: string;
}) {
  const { documentFillRuns } = await getAiCollections();
  const now = new Date();
  const run: DocumentFillRunDocument = {
    _id: new ObjectId(),
    tenantId: input.tenantId,
    documentId: input.documentId,
    format: input.format,
    sourceVersionId: input.sourceVersionId,
    sourceStorageRevision: input.sourceStorageRevision,
    sourceSha256: input.sourceSha256,
    snapshotId: input.snapshotId,
    snapshotHash: input.snapshotHash,
    pdf: null,
    status: "queued",
    stage: "queued",
    fields: [],
    generatedDocumentId: null,
    error: null,
    startedByUserId: input.userId,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
  };
  await documentFillRuns.insertOne(run);
  return run;
}

export async function updateFillRun(
  runId: ObjectId,
  patch: Partial<
    Pick<
      DocumentFillRunDocument,
      "status" | "stage" | "fields" | "pdf" | "generatedDocumentId" | "error" | "finishedAt"
    >
  >,
) {
  const { documentFillRuns } = await getAiCollections();
  await documentFillRuns.updateOne({ _id: runId }, { $set: { ...patch, updatedAt: new Date() } });
}

export async function patchFillFields(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  updates: Array<{ id: string; value?: string | null; state?: DocumentFillField["state"] }>;
}) {
  const { documentFillRuns } = await getAiCollections();
  const run = await latestFillRun(input.tenantId, input.documentId);
  if (!run || run.status !== "review") return null;
  const updates = new Map(input.updates.map((item) => [item.id, item]));
  const fields = run.fields.map((field) => {
    const update = updates.get(field.id);
    if (!update) return field;
    const value = update.value === undefined ? field.value : update.value?.trim() || null;
    // canAutoApply keeps a user-typed value from promoting an UNVERIFIABLE
    // target: vision-derived overlay geometry on a scanned page has nothing
    // checking it, so supplying the value settles the answer but not the
    // position. No-op for docx, where every locator is verifiable.
    const state = update.state
      ? update.state
      : field.sensitive
        ? "manual"
        : value && canAutoApply(field.locator)
          ? "ready"
          : value
            ? "needs_review"
            : "missing";
    return {
      ...field,
      value,
      state,
      confidence: value ? 1 : 0,
      updatedBy: "user" as const,
      evidence: value
        ? [{ source: "user" as const, reference: "document_chat", excerpt: value.slice(0, 240) }]
        : [],
      reason: value ? "Provided for this document only." : field.reason,
    };
  });
  await documentFillRuns.updateOne(
    { _id: run._id, status: "review" },
    { $set: { fields, updatedAt: new Date() } },
  );
  return { ...run, fields, updatedAt: new Date() };
}
