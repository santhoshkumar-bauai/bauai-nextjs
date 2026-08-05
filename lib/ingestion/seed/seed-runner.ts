import { ingestionEnv } from "../config/env.ts";
import { IngestionError } from "../http/errors.ts";
import { describeError, logger } from "../observability/logger.ts";
import { recordDeadLetter } from "../pipeline/dead-letter.ts";
import { processNoticeJob } from "../pipeline/process-notice.ts";
import { startRun } from "../pipeline/runs.ts";
import { createAdapter } from "../sources/registry.ts";
import { getSourceConfig } from "../scheduler/source-configs.ts";
import type {
  DiscoveredNotice,
  NoticeJob,
  SourceConfigDocument,
  TenderSourceCode,
} from "../types.ts";
import { sha256 } from "../utils/hash.ts";
import { sleep } from "../utils/time.ts";
import {
  claimPartition,
  completePartition,
  failPartition,
  heartbeatPartition,
  planMonthPartitions,
  registerPartitions,
  releasePartition,
  releaseStalePartitions,
  type SeedPartition,
} from "./partitions.ts";

const log = logger.child("seed");

/**
 * Direct historical seeder.
 *
 * The production path is scheduler -> Redis -> ingest workers. A seed does not need
 * that: there is no discovery latency to hide and no live traffic to yield to, so
 * running the same pipeline in-process removes Redis from the requirements
 * entirely. Everything after discovery is shared with the workers —
 * `processNoticeJob` and the transactional writer — so a seeded tender is
 * byte-for-byte what live ingestion would have produced.
 */
export interface SeedOptions {
  sources: TenderSourceCode[];
  from: Date;
  to: Date;
  /** Stop after this many notices are processed. `null` seeds everything. */
  limit: number | null;
  concurrency: number;
  /** Overrides the source's configured requests-per-minute for this run only. */
  rateLimitPerMinute: number | null;
  signal?: AbortSignal;
  /**
   * Optional counters the caller may read while the seed runs. Reporting from the
   * runner's own tallies is accurate for every source, unlike counting documents,
   * which cannot distinguish this run's work from what was already seeded.
   */
  counters?: SeedCounters;
}

export interface SeedCounters {
  discovered: number;
  processed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
}

export interface SeedResult extends SeedCounters {
  partitionsCompleted: number;
  partitionsFailed: number;
  partitionsSkipped: number;
  startedAt: Date;
  finishedAt: Date;
  stoppedEarly: boolean;
}

function emptyCounters(): SeedCounters {
  return { discovered: 0, processed: 0, inserted: 0, updated: 0, unchanged: 0, failed: 0 };
}

export async function runSeed(options: SeedOptions): Promise<SeedResult> {
  const startedAt = new Date();
  const totals = options.counters ?? emptyCounters();
  let partitionsCompleted = 0;
  let partitionsFailed = 0;
  let partitionsSkipped = 0;
  let stoppedEarly = false;

  // A previous run killed mid-partition would otherwise leave months stuck RUNNING.
  const released = await releaseStalePartitions();
  if (released) log.info("released partitions abandoned by an earlier run", { released });

  for (const source of options.sources) {
    const config = await resolveConfig(source, options.rateLimitPerMinute);
    const partitions = planMonthPartitions(source, options.from, options.to);
    await registerPartitions(partitions);

    for (const partition of partitions) {
      if (options.signal?.aborted || reachedLimit(totals, options.limit)) {
        stoppedEarly = true;
        break;
      }

      // Already DONE partitions are not re-claimable, which is what makes an
      // interrupted seed resume where it left off rather than start over.
      if (!(await claimPartition(partition, ingestionEnv.workerId))) {
        partitionsSkipped += 1;
        log.debug("partition already done or held elsewhere", { partition: partition.label });
        continue;
      }

      try {
        const outcome = await seedPartition(partition, config, options, totals);

        if (outcome.exhausted) {
          await completePartition(partition, {
            discovered: outcome.counters.discovered,
            inserted: outcome.counters.inserted,
            updated: outcome.counters.updated,
            unchanged: outcome.counters.unchanged,
            failed: outcome.counters.failed,
          });
          partitionsCompleted += 1;
        } else {
          // Stopped by Ctrl-C or a --limit cutoff before the window was exhausted.
          // Marking it DONE here would make the next run skip the month and lose
          // whatever was left in it, so it goes back to PENDING instead.
          await releasePartition(partition);
          stoppedEarly = true;
          log.info("partition released unfinished; re-run to continue it", {
            partition: partition.label,
            processed: outcome.counters.processed,
          });
        }
      } catch (error) {
        partitionsFailed += 1;
        const described = describeError(error);
        await failPartition(partition, `${described.name}: ${described.message}`);
        log.error("partition failed", { partition: partition.label, ...described });

        // An aborted run must not be recorded as a source failure loop; stop.
        if (options.signal?.aborted) {
          stoppedEarly = true;
          break;
        }
      }
    }

    if (stoppedEarly) break;
  }

  return {
    ...totals,
    partitionsCompleted,
    partitionsFailed,
    partitionsSkipped,
    startedAt,
    finishedAt: new Date(),
    stoppedEarly,
  };
}

/**
 * Seeds one month. Each discovery batch is processed and released before the next
 * is requested, so peak memory is one batch rather than one month — a German
 * monthly archive holds several thousand inline XML documents.
 */
async function seedPartition(
  partition: SeedPartition,
  config: SourceConfigDocument,
  options: SeedOptions,
  totals: SeedCounters,
): Promise<{ counters: SeedCounters; exhausted: boolean }> {
  const counters = emptyCounters();
  const adapter = createAdapter(config);
  // Only a window read to completion may be recorded as DONE.
  let exhausted = true;

  const run = await startRun({
    source: config._id,
    mode: "backfill",
    partition: partition.label,
    windowFrom: partition.windowFrom,
    windowTo: partition.windowTo,
    parserVersion: config.parserVersion,
  });

  try {
    for await (const batch of adapter.discover({
      source: config._id,
      mode: "backfill",
      watermark: null,
      pageOrToken: null,
      lastOfficialId: null,
      windowFrom: partition.windowFrom,
      windowTo: partition.windowTo,
      etag: null,
      lastModified: null,
    })) {
      counters.discovered += batch.notices.length;
      totals.discovered += batch.notices.length;
      run.counters.discovered += batch.notices.length;

      if (batch.archive) {
        await run.recordArchive({
          checksum: batch.archive.checksum,
          byteLength: batch.archive.byteLength,
          httpStatus: batch.httpStatus,
        });
      }

      // Trim to the remaining allowance before dispatching. Checking the limit
      // inside each worker cannot be exact: with N workers, up to N-1 slip past the
      // check before any of them finishes and increments the count.
      const remaining =
        options.limit === null ? batch.notices.length : options.limit - totals.processed;
      const slice =
        remaining >= batch.notices.length ? batch.notices : batch.notices.slice(0, remaining);

      await processBatch(slice, config, options, counters, totals, run.id);
      await run.heartbeat();
      await heartbeatPartition(partition);

      if (options.signal?.aborted || reachedLimit(totals, options.limit)) {
        exhausted = false;
        break;
      }
    }

    run.counters.inserted = counters.inserted;
    run.counters.updated = counters.updated;
    run.counters.unchanged = counters.unchanged;
    run.counters.rejected = counters.failed;
    await run.succeed();
    return { counters, exhausted };
  } catch (error) {
    await run.fail(error);
    throw error;
  }
}

/**
 * Processes a batch with bounded concurrency, clearing each payload reference as it
 * completes so a large archive does not stay resident for the whole batch.
 */
async function processBatch(
  notices: DiscoveredNotice[],
  config: SourceConfigDocument,
  options: SeedOptions,
  counters: SeedCounters,
  totals: SeedCounters,
  runId: string,
): Promise<void> {
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted || reachedLimit(totals, options.limit)) return;

      const index = cursor;
      cursor += 1;
      if (index >= notices.length) return;

      const notice = notices[index];
      // Releasing the slot lets the payload be collected as soon as it is handled.
      notices[index] = undefined as unknown as DiscoveredNotice;

      await processOne(notice, config, counters, totals, runId);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, () => worker()),
  );
}

async function processOne(
  notice: DiscoveredNotice,
  config: SourceConfigDocument,
  counters: SeedCounters,
  totals: SeedCounters,
  runId: string,
): Promise<void> {
  const versionKey = notice.versionKey ?? sha256(notice.inlinePayload?.body ?? Buffer.alloc(0));
  const job: NoticeJob = {
    kind: "notice",
    source: notice.source,
    mode: "backfill",
    jobKey: `${notice.source}:${notice.sourceNoticeId}:${versionKey}`,
    notice: { ...notice, versionKey },
    runId,
    attempt: 1,
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await processNoticeJob(job, config);
      counters.processed += 1;
      totals.processed += 1;

      switch (result.outcome) {
        case "INSERTED":
          counters.inserted += 1;
          totals.inserted += 1;
          break;
        case "UPDATED":
          counters.updated += 1;
          totals.updated += 1;
          break;
        default:
          counters.unchanged += 1;
          totals.unchanged += 1;
      }
      return;
    } catch (error) {
      const retryable = error instanceof IngestionError ? error.retryable : false;
      if (retryable && attempt < 3) {
        await sleep(500 * attempt);
        continue;
      }

      // One malformed notice must never end a multi-hour seed; it is recorded for
      // replay and the run continues (§11.1).
      counters.failed += 1;
      totals.failed += 1;
      await recordDeadLetter({
        job,
        error,
        attempts: attempt,
        parserVersion: config.parserVersion,
        runId,
      }).catch((dlqError) =>
        log.error("failed to record dead letter", describeError(dlqError)),
      );
      return;
    }
  }
}

function reachedLimit(totals: SeedCounters, limit: number | null): boolean {
  return limit !== null && totals.processed >= limit;
}

async function resolveConfig(
  source: TenderSourceCode,
  rateLimitPerMinute: number | null,
): Promise<SourceConfigDocument> {
  const config = await getSourceConfig(source);
  if (!config) {
    throw new Error(
      `No source config for ${source}. Run "npm run ingestion:bootstrap" first.`,
    );
  }
  // Seeding is bulk work, so the operator may raise the request rate for this run
  // without changing the stored configuration that live polling uses.
  return rateLimitPerMinute ? { ...config, rateLimitPerMinute } : config;
}
