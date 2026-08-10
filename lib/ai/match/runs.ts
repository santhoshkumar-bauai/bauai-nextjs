import { ObjectId } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import type { CompanyMatchRunDocument } from "../types.ts";

/**
 * Lifecycle of an AI match refresh, persisted so it outlives the request that
 * started it — the user can reload, open a second tab, or close the laptop and
 * still find the run in progress.
 *
 * A deliberate sibling of `lib/ai/report/runs.ts` rather than a shared
 * abstraction: the key is tenant-only instead of tenant+tender, this one
 * carries batch progress counters and a completed-run pointer, and it has no
 * locale. Generalizing the two would make both harder to read than they are
 * apart.
 */

/**
 * How long a `running` row may go untouched before another request may claim
 * it. The runner heartbeats every 15s, so anything past this belongs to a
 * process that died mid-refresh.
 */
export const STALE_AFTER_MS = 90_000;
export const RUN_HEARTBEAT_MS = 15_000;

export type MatchStage = CompanyMatchRunDocument["stage"];

export interface MatchRunState {
  status: CompanyMatchRunDocument["status"];
  stage: MatchStage;
  progress: { done: number; total: number };
  scoredCount: number;
  judgedCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export function serializeRun(doc: CompanyMatchRunDocument): MatchRunState {
  return {
    status: doc.status,
    stage: doc.stage,
    progress: doc.progress,
    scoredCount: doc.scoredCount,
    judgedCount: doc.judgedCount,
    error: doc.error,
    startedAt: doc.startedAt.toISOString(),
    finishedAt: doc.finishedAt ? doc.finishedAt.toISOString() : null,
  };
}

function isStale(doc: CompanyMatchRunDocument): boolean {
  return Date.now() - doc.updatedAt.getTime() > STALE_AFTER_MS;
}

export async function getRun(
  tenantId: ObjectId,
): Promise<CompanyMatchRunDocument | null> {
  const { companyMatchRuns } = await getAiCollections();
  const doc = await companyMatchRuns.findOne({ tenantId });
  if (!doc) return null;

  // A heartbeat that stopped means the worker died; report it as failed rather
  // than leaving the page waiting on a run that will never finish.
  if (doc.status === "running" && isStale(doc)) {
    return { ...doc, status: "failed", error: "failed" };
  }
  return doc;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: number }).code === 11000
  );
}

/**
 * Claims the right to refresh. Returns null when another run is already in
 * flight — the caller then watches that run instead of paying for a second,
 * equally expensive one.
 *
 * `lastCompletedRunId` is deliberately NOT reset here: readers keep being
 * served the previous complete result set for the whole duration of the new
 * run, which is what makes a refresh invisible to someone paging through
 * results.
 */
export async function claimRun(input: {
  tenantId: ObjectId;
  companyDataHash: string;
  promptVersion: string;
  pipelineVersion: string;
  embeddingIdentity: string;
  trigger: CompanyMatchRunDocument["trigger"];
  userId: string | null;
}): Promise<CompanyMatchRunDocument | null> {
  const { companyMatchRuns } = await getAiCollections();
  const now = new Date();
  const staleCutoff = new Date(now.getTime() - STALE_AFTER_MS);

  const claim = {
    status: "running" as const,
    stage: "building_profile" as const,
    progress: { done: 0, total: 0 },
    trigger: input.trigger,
    runId: new ObjectId(),
    companyDataHash: input.companyDataHash,
    promptVersion: input.promptVersion,
    pipelineVersion: input.pipelineVersion,
    embeddingIdentity: input.embeddingIdentity,
    scoredCount: 0,
    judgedCount: 0,
    startedByUserId: input.userId,
    error: null,
    startedAt: now,
    finishedAt: null,
    updatedAt: now,
  };

  try {
    const result = await companyMatchRuns.findOneAndUpdate(
      {
        tenantId: input.tenantId,
        // Free to claim when nothing is running, or when the running row's
        // heartbeat has gone quiet.
        $or: [{ status: { $ne: "running" } }, { updatedAt: { $lt: staleCutoff } }],
      },
      {
        $set: claim,
        $setOnInsert: { createdAt: now, lastCompletedRunId: null },
      },
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

export async function markStage(
  tenantId: ObjectId,
  stage: MatchStage,
): Promise<void> {
  const { companyMatchRuns } = await getAiCollections();
  await companyMatchRuns.updateOne(
    { tenantId },
    { $set: { stage, updatedAt: new Date() } },
  );
}

/** Judge-batch progress; also serves as a heartbeat. */
export async function markProgress(
  tenantId: ObjectId,
  progress: { done: number; total: number },
): Promise<void> {
  const { companyMatchRuns } = await getAiCollections();
  await companyMatchRuns.updateOne(
    { tenantId },
    { $set: { progress, updatedAt: new Date() } },
  );
}

/** Keeps the claim alive during long stages that emit no progress. */
export async function heartbeat(tenantId: ObjectId): Promise<void> {
  const { companyMatchRuns } = await getAiCollections();
  await companyMatchRuns.updateOne(
    { tenantId, status: "running" },
    { $set: { updatedAt: new Date() } },
  );
}

/**
 * Publishes the run: flips `lastCompletedRunId` to the rows this run wrote and
 * deletes everything left over from earlier runs.
 *
 * The order matters. Rows are already written and readers are still pinned to
 * the *previous* run, so the flip is the single instant at which the feed
 * changes — nobody can observe a half-old, half-new page. Only then is the old
 * generation swept.
 */
export async function publishRun(input: {
  tenantId: ObjectId;
  runId: ObjectId;
  scoredCount: number;
  judgedCount: number;
}): Promise<void> {
  const { companyMatchRuns, tenderMatchScores } = await getAiCollections();
  const now = new Date();

  await companyMatchRuns.updateOne(
    { tenantId: input.tenantId },
    {
      $set: {
        status: "done",
        stage: "finalizing",
        lastCompletedRunId: input.runId,
        scoredCount: input.scoredCount,
        judgedCount: input.judgedCount,
        error: null,
        finishedAt: now,
        updatedAt: now,
      },
    },
  );

  await tenderMatchScores.deleteMany({
    tenantId: input.tenantId,
    runId: { $ne: input.runId },
  });
}

export async function failRun(tenantId: ObjectId, error: string): Promise<void> {
  const { companyMatchRuns } = await getAiCollections();
  const now = new Date();
  await companyMatchRuns.updateOne(
    { tenantId },
    { $set: { status: "failed", error, finishedAt: now, updatedAt: now } },
  );
}
