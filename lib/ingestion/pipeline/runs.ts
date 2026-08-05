import { randomUUID } from "node:crypto";

import { ingestionEnv } from "../config/env.ts";
import { getCollections } from "../db/collections.ts";
import { describeError } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import { IngestionError } from "../http/errors.ts";
import type {
  IngestionMode,
  IngestionRunCounters,
  IngestionRunDocument,
  TenderSourceCode,
} from "../types.ts";

/** One record per poll, package, reconciliation window, or backfill partition (§6.4). */
export interface RunHandle {
  id: string;
  counters: IngestionRunCounters;
  heartbeat(): Promise<void>;
  /** Archive manifest data for reconciliation, recorded while still running. */
  recordArchive(input: {
    checksum: string;
    byteLength: number;
    httpStatus?: number | null;
  }): Promise<void>;
  succeed(extra?: Partial<IngestionRunDocument>): Promise<void>;
  markUnchanged(): Promise<void>;
  fail(error: unknown): Promise<void>;
}

export function emptyCounters(): IngestionRunCounters {
  return {
    discovered: 0,
    fetched: 0,
    unchanged: 0,
    inserted: 0,
    updated: 0,
    rejected: 0,
    retried: 0,
    deadLettered: 0,
  };
}

export async function startRun(input: {
  source: TenderSourceCode;
  mode: IngestionMode;
  partition?: string | null;
  windowFrom?: Date | null;
  windowTo?: Date | null;
  parserVersion: string;
}): Promise<RunHandle> {
  const collections = await getCollections();
  const now = new Date();
  const id = `${input.source}:${input.mode}:${now.toISOString()}:${randomUUID().slice(0, 8)}`;
  const counters = emptyCounters();

  await collections.ingestionRuns.insertOne({
    _id: id,
    source: input.source,
    mode: input.mode,
    partition: input.partition ?? null,
    windowFrom: input.windowFrom ?? null,
    windowTo: input.windowTo ?? null,
    status: "RUNNING",
    startedAt: now,
    heartbeatAt: now,
    completedAt: null,
    httpStatus: null,
    archiveChecksum: null,
    archiveByteLength: null,
    parserVersion: input.parserVersion,
    counters,
    error: null,
    worker: ingestionEnv.workerId,
  });

  const finish = async (
    status: IngestionRunDocument["status"],
    extra: Partial<IngestionRunDocument> = {},
  ) => {
    const completedAt = new Date();
    await collections.ingestionRuns.updateOne(
      { _id: id },
      {
        $set: {
          status,
          completedAt,
          heartbeatAt: completedAt,
          counters,
          ...extra,
        },
      },
    );
    metrics.observe(
      "ingestion_run_duration_ms",
      completedAt.getTime() - now.getTime(),
      { source: input.source, mode: input.mode, status },
    );
  };

  return {
    id,
    counters,
    // A stale heartbeat is how section 15.3 detects a worker that died mid-run.
    heartbeat: async () => {
      await collections.ingestionRuns.updateOne(
        { _id: id },
        { $set: { heartbeatAt: new Date(), counters } },
      );
    },
    recordArchive: async ({ checksum, byteLength, httpStatus }) => {
      await collections.ingestionRuns.updateOne(
        { _id: id },
        {
          $set: {
            archiveChecksum: checksum,
            archiveByteLength: byteLength,
            ...(httpStatus === undefined ? {} : { httpStatus }),
            heartbeatAt: new Date(),
            counters,
          },
        },
      );
    },
    succeed: (extra) => finish("SUCCEEDED", extra),
    markUnchanged: () => finish("UNCHANGED"),
    fail: async (error) => {
      const described = describeError(error);
      await finish("FAILED", {
        error: {
          name: described.name,
          message: described.message.slice(0, 2_000),
          retryable: error instanceof IngestionError ? error.retryable : false,
        },
        httpStatus: error instanceof IngestionError ? (error.httpStatus ?? null) : null,
      });
    },
  };
}

/**
 * Marks runs whose worker stopped heartbeating so they do not appear to be
 * running forever. Called by the scheduler on a slow interval.
 */
export async function expireStaleRuns(olderThanMs = 15 * 60 * 1000): Promise<number> {
  const collections = await getCollections();
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await collections.ingestionRuns.updateMany(
    { status: "RUNNING", heartbeatAt: { $lt: cutoff } },
    { $set: { status: "STALE", completedAt: new Date() } },
  );
  return result.modifiedCount;
}
