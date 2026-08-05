import { hostname } from "node:os";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not configured. Add it to .env.local.`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, received "${raw}".`);
  }
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

/**
 * A worker identity that is stable for the life of the process and unique per
 * replica. Mongo leases and Redis consumer names both depend on it, so a
 * container restart must produce a new value.
 */
function workerId(): string {
  return (
    process.env.INGESTION_WORKER_ID ||
    `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  );
}

export const ingestionEnv = {
  workerId: workerId(),
  nodeEnv: process.env.NODE_ENV ?? "development",

  mongoUri: required("MONGODB_URI"),
  mongoDb: process.env.MONGODB_DB || "bauai",

  redisUrl: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  /** Prefix keeps staging and production streams apart on a shared Redis. */
  redisKeyPrefix: process.env.INGESTION_REDIS_PREFIX || "bauai:ingestion",

  s3: {
    bucket: process.env.S3_BUCKET_NAME ?? "",
    endpoint: process.env.S3_ENDPOINT ?? "",
    region: process.env.S3_REGION || "us-east-1",
    keyId: process.env.S3_KEY_ID ?? "",
    applicationKey: process.env.S3_APPLICATION_KEY ?? "",
    prefix: process.env.S3_RAW_NOTICE_PREFIX || "tenders/raw",
  },

  /** Optional TED API key. Without it the adapter uses the public search API. */
  tedApiKey: process.env.TED_API_KEY ?? "",

  worker: {
    /** Notices processed concurrently by one ingest worker. */
    concurrency: integer("INGESTION_CONCURRENCY", 8),
    /** Redelivery deadline; a job is reclaimed once it exceeds this (§5.1). */
    visibilityTimeoutMs: integer("INGESTION_VISIBILITY_TIMEOUT_MS", 300_000),
    heartbeatIntervalMs: integer("INGESTION_HEARTBEAT_INTERVAL_MS", 30_000),
    maxAttempts: integer("INGESTION_MAX_ATTEMPTS", 5),
    /** Reserve capacity for live work; backfill is only polled below this (§9.4). */
    backfillShare: Number(process.env.INGESTION_BACKFILL_SHARE ?? "0.3"),
    shutdownGraceMs: integer("INGESTION_SHUTDOWN_GRACE_MS", 30_000),
  },

  scheduler: {
    tickIntervalMs: integer("INGESTION_SCHEDULER_TICK_MS", 15_000),
    leaseTtlMs: integer("INGESTION_LEASE_TTL_MS", 120_000),
    /** Pause backfill when live discovery latency breaches this (§9.4). */
    liveLatencySloMs: integer("INGESTION_LIVE_LATENCY_SLO_MS", 300_000),
  },

  outbox: {
    /** Redis pub/sub channel the app subscribes to for SSE/WebSocket fan-out. */
    channel: process.env.INGESTION_OUTBOX_CHANNEL || "bauai:tenders:events",
    batchSize: integer("INGESTION_OUTBOX_BATCH_SIZE", 200),
    sweepIntervalMs: integer("INGESTION_OUTBOX_SWEEP_MS", 30_000),
    maxAttempts: integer("INGESTION_OUTBOX_MAX_ATTEMPTS", 10),
  },

  status: {
    intervalMs: integer("INGESTION_STATUS_INTERVAL_MS", 300_000),
    closingSoonHours: integer("INGESTION_CLOSING_SOON_HOURS", 48),
  },

  limits: {
    /** Caps for archive handling; both are anti-zip-bomb guards (§16). */
    maxArchiveBytes: integer("INGESTION_MAX_ARCHIVE_BYTES", 1_500_000_000),
    maxEntryBytes: integer("INGESTION_MAX_ENTRY_BYTES", 64_000_000),
    maxArchiveEntries: integer("INGESTION_MAX_ARCHIVE_ENTRIES", 200_000),
  },

  /** Shadow mode writes MongoDB but publishes no application events (§18.3). */
  shadowMode: boolean("INGESTION_SHADOW_MODE", false),
  logLevel: process.env.INGESTION_LOG_LEVEL || "info",
} as const;

export function assertS3Configured(): void {
  const { bucket, endpoint, keyId, applicationKey } = ingestionEnv.s3;
  if (!bucket || !endpoint || !keyId || !applicationKey) {
    throw new Error(
      "S3 raw payload storage requires S3_BUCKET_NAME, S3_ENDPOINT, S3_KEY_ID and S3_APPLICATION_KEY.",
    );
  }
}
