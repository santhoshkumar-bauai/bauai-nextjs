import { ingestionEnv } from "../../ingestion/config/env.ts";

/**
 * BullMQ connection options. Plain options rather than a shared ioredis
 * instance for two reasons: BullMQ bundles its own ioredis whose types clash
 * with the repo's ioredis v6, and BullMQ manages blocking-command connections
 * itself (duplicating as needed) when given options. `maxRetriesPerRequest:
 * null` is a BullMQ requirement — its blocking reads must never be cut short
 * by the retry limiter.
 */
export interface AiRedisOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
  maxRetriesPerRequest: null;
  enableReadyCheck: boolean;
}

export function aiRedisOptions(): AiRedisOptions {
  const url = new URL(ingestionEnv.redisUrl);
  const options: AiRedisOptions = {
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number(url.port) : 6379,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  };
  if (url.username) options.username = decodeURIComponent(url.username);
  if (url.password) options.password = decodeURIComponent(url.password);
  const dbPath = url.pathname.replace(/^\//, "");
  if (dbPath) options.db = Number(dbPath);
  return options;
}
