import type { QueueName } from "../types.ts";
import { redisKey } from "./client.ts";

/**
 * Priority order the ingest worker polls in. Live work always wins; backfill is
 * only reached when higher queues are empty and the live SLO is healthy (§9.4).
 */
export const queuePriority: QueueName[] = [
  "live",
  "reconciliation",
  "enrichment",
  "backfill",
];

export const consumerGroup = "ingest";

export function streamKey(queue: QueueName): string {
  return redisKey("stream", queue);
}

/** Idempotency set per queue, so an overlap window does not re-enqueue work. */
export function seenKey(queue: QueueName): string {
  return redisKey("seen", queue);
}

export function deadLetterStreamKey(): string {
  return streamKey("dead-letter");
}
