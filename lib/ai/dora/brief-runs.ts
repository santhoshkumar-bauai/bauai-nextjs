import type { ObjectId } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import type { DocumentBriefRunDocument } from "../types.ts";

/**
 * Lifecycle of a brief generation, persisted so it outlives the request that
 * started it — the panel can reload mid-run and resume watching the same
 * stages. Mirrors lib/ai/report/runs.ts: unique (tenantId, documentId) index
 * makes claiming race-safe, `updatedAt` doubles as the heartbeat.
 */

const STALE_AFTER_MS = 90_000;
export const BRIEF_HEARTBEAT_MS = 15_000;

export type BriefStage = DocumentBriefRunDocument["stage"];

export interface BriefRunState {
  status: DocumentBriefRunDocument["status"];
  stage: BriefStage;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function serializeBriefRun(doc: DocumentBriefRunDocument): BriefRunState {
  return {
    status: doc.status,
    stage: doc.stage,
    error: doc.error,
    startedAt: doc.startedAt.toISOString(),
    finishedAt: doc.finishedAt ? doc.finishedAt.toISOString() : null,
  };
}

function isStale(doc: DocumentBriefRunDocument): boolean {
  return Date.now() - doc.updatedAt.getTime() > STALE_AFTER_MS;
}

export async function getBriefRun(
  tenantId: ObjectId,
  documentId: ObjectId,
): Promise<DocumentBriefRunDocument | null> {
  const { documentBriefRuns } = await getAiCollections();
  const doc = await documentBriefRuns.findOne({ tenantId, documentId });
  if (!doc) return null;
  // A silent heartbeat means the process died; report failed, not spinning.
  if (doc.status === "running" && isStale(doc)) {
    return { ...doc, status: "failed", error: "failed" };
  }
  return doc;
}

/** Claim the right to generate; null = someone else's run is in flight. */
export async function claimBriefRun(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  userId: string;
}): Promise<DocumentBriefRunDocument | null> {
  const { documentBriefRuns } = await getAiCollections();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_AFTER_MS);

  const claim = {
    status: "running" as const,
    stage: "extracting" as const,
    startedByUserId: input.userId,
    error: null,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };

  try {
    const result = await documentBriefRuns.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        documentId: input.documentId,
        $or: [{ status: { $ne: "running" } }, { updatedAt: { $lt: staleCutoff } }],
      },
      { $set: claim, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return result ?? null;
  } catch (error) {
    // Losing the upsert race trips the unique index — that IS the mechanism.
    if ((error as { code?: number })?.code === 11000) return null;
    throw error;
  }
}

export async function markBriefStage(
  tenantId: ObjectId,
  documentId: ObjectId,
  stage: BriefStage,
): Promise<void> {
  const { documentBriefRuns } = await getAiCollections();
  await documentBriefRuns.updateOne(
    { tenantId, documentId },
    { $set: { stage, updatedAt: new Date() } },
  );
}

export async function heartbeatBriefRun(
  tenantId: ObjectId,
  documentId: ObjectId,
): Promise<void> {
  const { documentBriefRuns } = await getAiCollections();
  await documentBriefRuns.updateOne(
    { tenantId, documentId, status: "running" },
    { $set: { updatedAt: new Date() } },
  );
}

export async function finishBriefRun(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  error: string | null;
}): Promise<void> {
  const { documentBriefRuns } = await getAiCollections();
  const now = new Date();
  await documentBriefRuns.updateOne(
    { tenantId: input.tenantId, documentId: input.documentId },
    {
      $set: {
        status: input.error ? "failed" : "done",
        error: input.error,
        finishedAt: now,
        updatedAt: now,
      },
    },
  );
}
