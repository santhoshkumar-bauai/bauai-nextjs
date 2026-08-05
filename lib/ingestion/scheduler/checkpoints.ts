import { ingestionEnv } from "../config/env.ts";
import { getCollections } from "../db/collections.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type {
  DiscoveryCursor,
  IngestionMode,
  SourceCheckpointDocument,
  TenderSourceCode,
} from "../types.ts";

const log = logger.child("checkpoints");

export function checkpointId(source: TenderSourceCode, mode: IngestionMode): string {
  return `${source}:${mode}`;
}

/**
 * Loads or creates the cursor for one source and mode. Section 6.3 keeps these
 * independent so a backfill partition can never move the live watermark (§9.4).
 */
export async function loadCheckpoint(
  source: TenderSourceCode,
  mode: IngestionMode,
): Promise<SourceCheckpointDocument> {
  const collections = await getCollections();
  const _id = checkpointId(source, mode);

  await collections.sourceCheckpoints.updateOne(
    { _id },
    {
      $setOnInsert: {
        source,
        mode,
        watermark: null,
        pageOrToken: null,
        lastOfficialId: null,
        overlapFrom: null,
        windowFrom: null,
        windowTo: null,
        etag: null,
        lastModified: null,
        leaseOwner: null,
        leaseUntil: null,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        lastSuccessfulRunAt: null,
        nextRunAt: null,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  const checkpoint = await collections.sourceCheckpoints.findOne({ _id });
  if (!checkpoint) throw new Error(`Checkpoint ${_id} vanished after upsert`);
  return checkpoint;
}

export function toCursor(
  checkpoint: SourceCheckpointDocument,
  overlapSeconds: number,
): DiscoveryCursor {
  // An overlap window is used instead of querying strictly after the watermark,
  // because sources publish out of order and late (§4.1).
  const overlapFrom = checkpoint.watermark
    ? new Date(checkpoint.watermark.getTime() - overlapSeconds * 1_000)
    : null;

  return {
    source: checkpoint.source,
    mode: checkpoint.mode,
    watermark: checkpoint.watermark,
    pageOrToken: checkpoint.pageOrToken,
    lastOfficialId: checkpoint.lastOfficialId,
    windowFrom: checkpoint.windowFrom ?? overlapFrom,
    windowTo: checkpoint.windowTo,
    etag: checkpoint.etag,
    lastModified: checkpoint.lastModified,
  };
}

/**
 * Persists a cursor. Callers must only do this once every discovered job in the
 * batch is durably accepted by the queue, per section 6.3 — otherwise a crash
 * would advance past notices that were never enqueued.
 */
export async function saveCheckpoint(
  source: TenderSourceCode,
  mode: IngestionMode,
  cursor: DiscoveryCursor,
): Promise<void> {
  const collections = await getCollections();
  await collections.sourceCheckpoints.updateOne(
    { _id: checkpointId(source, mode) },
    {
      $set: {
        watermark: cursor.watermark,
        pageOrToken: cursor.pageOrToken,
        lastOfficialId: cursor.lastOfficialId,
        overlapFrom: cursor.windowFrom,
        windowFrom: cursor.windowFrom,
        windowTo: cursor.windowTo,
        etag: cursor.etag,
        lastModified: cursor.lastModified,
        updatedAt: new Date(),
      },
    },
  );

  if (cursor.watermark) {
    metrics.gauge(
      "ingestion_source_watermark_seconds",
      Math.round(cursor.watermark.getTime() / 1000),
      { source, mode },
    );
  }
}

export async function markCheckpointSuccess(
  source: TenderSourceCode,
  mode: IngestionMode,
): Promise<void> {
  const collections = await getCollections();
  const now = new Date();
  await collections.sourceCheckpoints.updateOne(
    { _id: checkpointId(source, mode) },
    {
      $set: {
        lastSuccessfulRunAt: now,
        consecutiveFailures: 0,
        circuitOpenUntil: null,
        updatedAt: now,
      },
    },
  );
  metrics.gauge(
    "ingestion_last_success_seconds",
    Math.round(now.getTime() / 1000),
    { source, mode },
  );
}

/**
 * Records a failure and opens the source circuit once the threshold is reached.
 * While open, the scheduler probes on a slow interval rather than flooding a
 * source that is already struggling (§11.2).
 */
export async function markCheckpointFailure(
  source: TenderSourceCode,
  mode: IngestionMode,
  threshold: number,
  probeIntervalMs = 5 * 60 * 1000,
): Promise<{ circuitOpen: boolean; consecutiveFailures: number }> {
  const collections = await getCollections();
  const updated = await collections.sourceCheckpoints.findOneAndUpdate(
    { _id: checkpointId(source, mode) },
    { $inc: { consecutiveFailures: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: "after" },
  );

  const failures = updated?.consecutiveFailures ?? 1;
  const circuitOpen = failures >= threshold;

  if (circuitOpen) {
    await collections.sourceCheckpoints.updateOne(
      { _id: checkpointId(source, mode) },
      { $set: { circuitOpenUntil: new Date(Date.now() + probeIntervalMs) } },
    );
    log.error("source circuit opened", { source, mode, failures });
  }

  metrics.gauge("ingestion_source_consecutive_failures", failures, { source, mode });
  metrics.gauge("ingestion_source_circuit_open", circuitOpen ? 1 : 0, { source, mode });

  return { circuitOpen, consecutiveFailures: failures };
}

/** Explicit window for a reconciliation or backfill run. */
export async function setCheckpointWindow(
  source: TenderSourceCode,
  mode: IngestionMode,
  windowFrom: Date | null,
  windowTo: Date | null,
): Promise<void> {
  const collections = await getCollections();
  await collections.sourceCheckpoints.updateOne(
    { _id: checkpointId(source, mode) },
    {
      $set: {
        windowFrom,
        windowTo,
        // Pagination state belongs to the previous window.
        pageOrToken: null,
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );
}

/** Schedules the next run, with jitter so pollers never align (§4.1). */
export async function scheduleNextRun(
  source: TenderSourceCode,
  mode: IngestionMode,
  intervalSeconds: number,
  jitterRatio: number,
): Promise<Date> {
  const collections = await getCollections();
  const delayMs = Math.round(
    intervalSeconds * 1_000 * (1 + Math.random() * jitterRatio),
  );
  const nextRunAt = new Date(Date.now() + delayMs);

  await collections.sourceCheckpoints.updateOne(
    { _id: checkpointId(source, mode) },
    { $set: { nextRunAt, updatedAt: new Date() } },
  );
  return nextRunAt;
}

export function isDue(checkpoint: SourceCheckpointDocument, now = new Date()): boolean {
  if (isCircuitOpen(checkpoint)) return false;
  return !checkpoint.nextRunAt || checkpoint.nextRunAt.getTime() <= now.getTime();
}

/** A circuit that has expired is probed once, on the normal schedule. */
export function isProbeDue(
  checkpoint: SourceCheckpointDocument,
  now = new Date(),
): boolean {
  return Boolean(
    checkpoint.circuitOpenUntil && checkpoint.circuitOpenUntil.getTime() <= now.getTime(),
  );
}

export function isCircuitOpen(checkpoint: SourceCheckpointDocument): boolean {
  return Boolean(
    checkpoint.circuitOpenUntil && checkpoint.circuitOpenUntil.getTime() > Date.now(),
  );
}

/** Whether a source has missed its live SLO, used for alerting and backfill pausing. */
export async function liveStaleness(): Promise<
  Array<{ source: TenderSourceCode; staleMs: number }>
> {
  const collections = await getCollections();
  const checkpoints = await collections.sourceCheckpoints
    .find({ mode: "live" })
    .toArray();

  return checkpoints.map((checkpoint) => ({
    source: checkpoint.source,
    staleMs: checkpoint.lastSuccessfulRunAt
      ? Date.now() - checkpoint.lastSuccessfulRunAt.getTime()
      : Number.POSITIVE_INFINITY,
  }));
}

export const leaseTtlMs = ingestionEnv.scheduler.leaseTtlMs;
