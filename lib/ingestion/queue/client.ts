import Redis, { type RedisOptions } from "ioredis";

import { ingestionEnv } from "../config/env.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child("redis");

const baseOptions: RedisOptions = {
  // Blocking XREADGROUP holds a connection open, so an unbounded retry queue
  // would mask a dead Redis instead of surfacing it.
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
};

const connections = new Set<Redis>();

/**
 * A separate connection per role. Blocking reads and pub/sub subscriptions both
 * monopolise a connection, so sharing one would stall producers.
 */
export function createRedis(role: string): Redis {
  const client = new Redis(ingestionEnv.redisUrl, {
    ...baseOptions,
    connectionName: `bauai-${role}-${ingestionEnv.workerId}`,
  });

  client.on("error", (error) => log.error("redis error", { role, error: error.message }));
  client.on("end", () => log.warn("redis connection closed", { role }));

  connections.add(client);
  return client;
}

export async function closeRedisConnections(): Promise<void> {
  const open = [...connections];
  connections.clear();
  await Promise.allSettled(open.map((client) => client.quit()));
}

export function redisKey(...parts: string[]): string {
  return [ingestionEnv.redisKeyPrefix, ...parts].join(":");
}
