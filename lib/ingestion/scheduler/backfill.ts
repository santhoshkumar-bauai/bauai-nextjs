import { logger } from "../observability/logger.ts";
import type { StreamQueue } from "../queue/stream-queue.ts";
import type {
  DiscoveryJob,
  SourceConfigDocument,
  TenderSourceCode,
} from "../types.ts";
import { addMonths, startOfUtcDay, toDayKey, toMonthKey } from "../utils/time.ts";

const log = logger.child("backfill");

export interface BackfillPartition {
  source: TenderSourceCode;
  label: string;
  windowFrom: Date;
  windowTo: Date;
}

/**
 * Generates historical partitions in the section 9.1 priority order:
 *
 *   1. the current day and previous 30 days;
 *   2. the previous 12 months;
 *   3. months 13 to the configured horizon.
 *
 * Priority 2 in the document — "every notice whose deadline is still in the
 * future" — is not a date window, so it is covered by the recent-days partitions
 * plus live ingestion rather than by a separate partition type.
 */
export function planBackfillPartitions(
  config: SourceConfigDocument,
  options: { horizonMonths?: number; now?: Date } = {},
): BackfillPartition[] {
  const now = options.now ?? new Date();
  const horizonMonths = options.horizonMonths ?? config.backfillHorizonMonths;
  const today = startOfUtcDay(now);
  const partitions: BackfillPartition[] = [];

  // Recent history is partitioned by day so the newest data lands first and any
  // single failure costs one day rather than one month.
  for (let offset = 0; offset <= 30; offset += 1) {
    const from = new Date(today.getTime() - offset * 86_400_000);
    const to = new Date(from.getTime() + 86_400_000);
    partitions.push({
      source: config._id,
      label: `day=${toDayKey(from)}`,
      windowFrom: from,
      windowTo: to,
    });
  }

  // Older history by month, newest first.
  const firstMonth = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  for (let offset = 1; offset <= horizonMonths; offset += 1) {
    const from = addMonths(firstMonth, -offset);
    const to = addMonths(from, 1);
    partitions.push({
      source: config._id,
      label: `month=${toMonthKey(from)}`,
      windowFrom: from,
      windowTo: to,
    });
  }

  return partitions;
}

/**
 * Enqueues partitions as discovery jobs on the low-priority backfill queue.
 *
 * Partitions are jobs rather than millions of pre-created notice messages, per
 * section 14, and they run on the workers so seeding scales horizontally without
 * competing with live ingestion for the scheduler's lease.
 */
export async function enqueueBackfill(
  queue: StreamQueue,
  partitions: BackfillPartition[],
): Promise<{ enqueued: number; duplicates: number }> {
  let enqueued = 0;
  let duplicates = 0;

  for (const partition of partitions) {
    const job: DiscoveryJob = {
      kind: "discovery",
      source: partition.source,
      mode: "backfill",
      // The label makes the key stable, so re-running the planner after an
      // interruption re-enqueues only partitions that were never accepted.
      jobKey: `backfill:${partition.source}:${partition.label}`,
      windowFrom: partition.windowFrom.toISOString(),
      windowTo: partition.windowTo.toISOString(),
      partition: partition.label,
      attempt: 0,
    };

    if (await queue.enqueue("backfill", job)) enqueued += 1;
    else duplicates += 1;
  }

  log.info("backfill partitions enqueued", {
    source: partitions[0]?.source,
    enqueued,
    duplicates,
  });
  return { enqueued, duplicates };
}
