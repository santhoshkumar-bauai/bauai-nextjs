import type { ObjectId } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import type { TenderReportRunDocument } from "../types.ts";
import type { ReportLocale } from "./schema.ts";
import type { ReportStage } from "./service.ts";

/**
 * Lifecycle of a report generation, persisted so it outlives the request that
 * started it.
 *
 * The reader can reload, open a second tab, or lose the connection entirely
 * and still find the run — the page reads this record, not a live stream.
 */

/**
 * How long a `running` row may go untouched before another request may claim
 * it. The runner heartbeats every 15s, so anything past this belongs to a
 * process that died mid-generation.
 */
const STALE_AFTER_MS = 90_000;
export const RUN_HEARTBEAT_MS = 15_000;

export interface ReportRunState {
  status: TenderReportRunDocument["status"];
  stage: ReportStage;
  locale: ReportLocale;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function serializeRun(doc: TenderReportRunDocument): ReportRunState {
  return {
    status: doc.status,
    stage: doc.stage,
    locale: doc.locale,
    error: doc.error,
    startedAt: doc.startedAt.toISOString(),
    finishedAt: doc.finishedAt ? doc.finishedAt.toISOString() : null,
  };
}

export async function getRun(
  tenantId: ObjectId,
  tenderId: ObjectId,
): Promise<TenderReportRunDocument | null> {
  const { tenderReportRuns } = await getAiCollections();
  const doc = await tenderReportRuns.findOne({ tenantId, tenderId });
  if (!doc) return null;

  // A heartbeat that stopped means the worker died; report it as failed rather
  // than leaving the page spinning on a run that will never finish.
  if (doc.status === "running" && isStale(doc)) {
    return { ...doc, status: "failed", error: "failed" };
  }
  return doc;
}

function isStale(doc: TenderReportRunDocument): boolean {
  return Date.now() - doc.updatedAt.getTime() > STALE_AFTER_MS;
}

/**
 * Claims the right to generate. Returns null when another run is already in
 * flight — the caller then simply watches that run instead of starting a
 * second, equally expensive one.
 */
export async function claimRun(input: {
  tenantId: ObjectId;
  tenderId: ObjectId;
  locale: ReportLocale;
  userId: string;
}): Promise<TenderReportRunDocument | null> {
  const { tenderReportRuns } = await getAiCollections();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_AFTER_MS);

  const claim = {
    status: "running" as const,
    stage: "gathering" as const,
    locale: input.locale,
    startedByUserId: input.userId,
    error: null,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };

  try {
    const result = await tenderReportRuns.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        tenderId: input.tenderId,
        // Free to claim when nothing is running, or when the running row's
        // heartbeat has gone quiet.
        $or: [{ status: { $ne: "running" } }, { updatedAt: { $lt: staleCutoff } }],
      },
      { $set: claim, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    return result ?? null;
  } catch (error) {
    // Two simultaneous claims: the filter matched nothing for the loser, its
    // upsert tried to insert, and the unique index rejected it. That is the
    // race working correctly — the loser watches instead.
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

export async function markStage(
  tenantId: ObjectId,
  tenderId: ObjectId,
  stage: ReportStage,
): Promise<void> {
  const { tenderReportRuns } = await getAiCollections();
  await tenderReportRuns.updateOne(
    { tenantId, tenderId },
    { $set: { stage, updatedAt: new Date() } },
  );
}

/** Keeps the claim alive during long stages that emit no progress. */
export async function heartbeat(
  tenantId: ObjectId,
  tenderId: ObjectId,
): Promise<void> {
  const { tenderReportRuns } = await getAiCollections();
  await tenderReportRuns.updateOne(
    { tenantId, tenderId, status: "running" },
    { $set: { updatedAt: new Date() } },
  );
}

export async function finishRun(input: {
  tenantId: ObjectId;
  tenderId: ObjectId;
  error: string | null;
}): Promise<void> {
  const { tenderReportRuns } = await getAiCollections();
  const now = new Date();
  await tenderReportRuns.updateOne(
    { tenantId: input.tenantId, tenderId: input.tenderId },
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
