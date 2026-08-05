import { getIngestionDb } from "../db/client.ts";
import type { TenderSourceCode } from "../types.ts";
import { addMonths, toMonthKey } from "../utils/time.ts";

/**
 * Seed partitions and their durable progress.
 *
 * A full-year seed is a multi-hour job, so it must survive Ctrl-C, a laptop
 * sleeping, and a source outage. Progress is tracked per month partition in its own
 * collection rather than in `source_checkpoints`, because section 9.4 forbids a
 * backfill from ever touching the live cursor.
 */
export interface SeedPartition {
  source: TenderSourceCode;
  label: string;
  windowFrom: Date;
  windowTo: Date;
}

export type SeedPartitionStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

export interface SeedPartitionDocument {
  _id: string;
  source: TenderSourceCode;
  label: string;
  windowFrom: Date;
  windowTo: Date;
  status: SeedPartitionStatus;
  discovered: number;
  inserted: number;
  updated: number;
  unchanged: number;
  failed: number;
  startedAt: Date | null;
  /**
   * Refreshed while a partition is being worked. A worker id cannot be used to
   * detect abandonment — it is regenerated every process start, so a crashed run's
   * partitions would never match the new process and would stay RUNNING forever.
   */
  heartbeatAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  worker: string | null;
}

/** How long a RUNNING partition may go without a heartbeat before it is reclaimed. */
export const PARTITION_STALE_MS = 10 * 60 * 1000;

export const seedPartitionsCollection = "seed_partitions";

export async function partitionStore() {
  const db = await getIngestionDb();
  return db.collection<SeedPartitionDocument>(seedPartitionsCollection);
}

export async function ensureSeedIndexes(): Promise<void> {
  const store = await partitionStore();
  await store.createIndexes([
    { key: { source: 1, status: 1 }, name: "ix_source_status" },
    { key: { status: 1, windowFrom: -1 }, name: "ix_status_window" },
    { key: { status: 1, heartbeatAt: 1 }, name: "ix_stale_running" },
  ]);
}

/**
 * Month partitions covering `[from, to)`, newest first.
 *
 * Newest-first matters: section 9.1 wants current data available while older
 * history is still loading, so an interrupted seed still leaves the most useful
 * months populated. Both required sources are month-partitionable — Germany
 * exposes `pubMonth` directly, and TED takes a bounded publication-date range.
 */
export function planMonthPartitions(
  source: TenderSourceCode,
  from: Date,
  to: Date,
): SeedPartition[] {
  const partitions: SeedPartition[] = [];
  const firstMonth = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));

  let cursor = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cursor.getTime() >= firstMonth.getTime()) {
    const windowFrom = cursor;
    const windowTo = addMonths(cursor, 1);
    partitions.push({
      source,
      label: toMonthKey(windowFrom),
      // Clamped to the requested range so `--from`/`--to` are respected exactly.
      windowFrom: windowFrom.getTime() < from.getTime() ? from : windowFrom,
      windowTo: windowTo.getTime() > to.getTime() ? to : windowTo,
    });
    cursor = addMonths(cursor, -1);
  }

  return partitions;
}

export function partitionId(partition: SeedPartition): string {
  return `${partition.source}:${partition.label}`;
}

/** Registers partitions without disturbing progress already recorded. */
export async function registerPartitions(partitions: SeedPartition[]): Promise<void> {
  if (!partitions.length) return;
  const store = await partitionStore();

  await store.bulkWrite(
    partitions.map((partition) => ({
      updateOne: {
        filter: { _id: partitionId(partition) },
        update: {
          $setOnInsert: {
            source: partition.source,
            label: partition.label,
            windowFrom: partition.windowFrom,
            windowTo: partition.windowTo,
            status: "PENDING" as SeedPartitionStatus,
            discovered: 0,
            inserted: 0,
            updated: 0,
            unchanged: 0,
            failed: 0,
            startedAt: null,
            heartbeatAt: null,
            completedAt: null,
            error: null,
            worker: null,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

/**
 * Claims a partition for this process. The `status` guard means two concurrent
 * seeders cannot work the same month, so the seed can be split across terminals.
 */
export async function claimPartition(
  partition: SeedPartition,
  worker: string,
): Promise<boolean> {
  const store = await partitionStore();
  const now = new Date();
  const claimed = await store.updateOne(
    { _id: partitionId(partition), status: { $in: ["PENDING", "FAILED"] } },
    {
      $set: {
        status: "RUNNING",
        startedAt: now,
        heartbeatAt: now,
        error: null,
        worker,
      },
    },
  );
  return claimed.modifiedCount === 1;
}

/** Keeps a long-running partition from being reclaimed as abandoned. */
export async function heartbeatPartition(partition: SeedPartition): Promise<void> {
  const store = await partitionStore();
  await store.updateOne(
    { _id: partitionId(partition), status: "RUNNING" },
    { $set: { heartbeatAt: new Date() } },
  );
}

/**
 * Returns a partition to the queue without recording progress.
 *
 * Used when a partition stops before its window is exhausted — Ctrl-C, or a
 * `--limit` cutoff. Marking such a partition DONE would make the next run skip it
 * and silently lose the rest of that month.
 */
export async function releasePartition(partition: SeedPartition): Promise<void> {
  const store = await partitionStore();
  await store.updateOne(
    { _id: partitionId(partition) },
    { $set: { status: "PENDING", worker: null, heartbeatAt: null } },
  );
}

export async function completePartition(
  partition: SeedPartition,
  counters: Pick<
    SeedPartitionDocument,
    "discovered" | "inserted" | "updated" | "unchanged" | "failed"
  >,
): Promise<void> {
  const store = await partitionStore();
  await store.updateOne(
    { _id: partitionId(partition) },
    { $set: { ...counters, status: "DONE", completedAt: new Date(), error: null } },
  );
}

export async function failPartition(
  partition: SeedPartition,
  error: string,
  counters?: Partial<SeedPartitionDocument>,
): Promise<void> {
  const store = await partitionStore();
  await store.updateOne(
    { _id: partitionId(partition) },
    {
      $set: {
        ...counters,
        status: "FAILED",
        completedAt: new Date(),
        error: error.slice(0, 1_000),
      },
    },
  );
}

export async function partitionProgress(): Promise<
  Record<SeedPartitionStatus, number> & { totals: { inserted: number; failed: number } }
> {
  const store = await partitionStore();
  const rows = await store
    .aggregate<{ _id: SeedPartitionStatus; count: number; inserted: number; failed: number }>([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          inserted: { $sum: "$inserted" },
          failed: { $sum: "$failed" },
        },
      },
    ])
    .toArray();

  const summary = {
    PENDING: 0,
    RUNNING: 0,
    DONE: 0,
    FAILED: 0,
    totals: { inserted: 0, failed: 0 },
  };
  for (const row of rows) {
    summary[row._id] = row.count;
    summary.totals.inserted += row.inserted;
    summary.totals.failed += row.failed;
  }
  return summary;
}

/** Clears progress so a seed starts over. Does not delete tenders. */
export async function resetPartitions(source?: TenderSourceCode): Promise<number> {
  const store = await partitionStore();
  const result = await store.deleteMany(source ? { source } : {});
  return result.deletedCount;
}

/**
 * Releases partitions left `RUNNING` by a process that died.
 *
 * Selected by heartbeat age rather than worker identity, because a restarted
 * process has a brand-new worker id and would never match its own abandoned work.
 * A partition still being actively seeded heartbeats well inside the window, so a
 * concurrent seeder in another terminal is never disturbed.
 */
export async function releaseStalePartitions(
  staleMs = PARTITION_STALE_MS,
): Promise<number> {
  const store = await partitionStore();
  const cutoff = new Date(Date.now() - staleMs);
  const result = await store.updateMany(
    {
      status: "RUNNING",
      $or: [{ heartbeatAt: { $lt: cutoff } }, { heartbeatAt: null }],
    },
    { $set: { status: "PENDING", worker: null, heartbeatAt: null } },
  );
  return result.modifiedCount;
}
