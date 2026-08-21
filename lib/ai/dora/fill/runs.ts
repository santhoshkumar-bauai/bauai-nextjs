import { ObjectId } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";

import type { DocumentFillField, DocumentFillRunDocument } from "./types";

export function serializeFillRun(run: DocumentFillRunDocument) {
  return {
    id: run._id.toHexString(),
    documentId: run.documentId.toHexString(),
    sourceVersionId: run.sourceVersionId.toHexString(),
    sourceStorageRevision: run.sourceStorageRevision,
    status: run.status,
    stage: run.stage,
    fields: run.fields,
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
  sourceVersionId: ObjectId;
  sourceStorageRevision: number;
  sourceSha256: string;
  snapshotId: string;
  snapshotHash: string;
  userId: string;
}) {
  const { documentFillRuns } = await getAiCollections();
  const now = new Date();
  const run: DocumentFillRunDocument = {
    _id: new ObjectId(),
    tenantId: input.tenantId,
    documentId: input.documentId,
    sourceVersionId: input.sourceVersionId,
    sourceStorageRevision: input.sourceStorageRevision,
    sourceSha256: input.sourceSha256,
    snapshotId: input.snapshotId,
    snapshotHash: input.snapshotHash,
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
  patch: Partial<Pick<DocumentFillRunDocument, "status" | "stage" | "fields" | "generatedDocumentId" | "error" | "finishedAt">>,
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
    const state = update.state
      ? update.state
      : field.sensitive
        ? "manual"
        : value && field.locator
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
