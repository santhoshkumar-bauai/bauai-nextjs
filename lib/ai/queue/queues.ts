import { Queue, type JobsOptions } from "bullmq";

import { aiEnv } from "../config/env.ts";
import { aiRedisOptions } from "./connection.ts";

/**
 * The full roadmap §10.1 queue map is declared up front so later phases add
 * consumers without renaming anything; in this phase only `embedding` and
 * `maintenance` have workers.
 */
export const AI_QUEUES = {
  acquisition: "ai-acquisition",
  parsing: "ai-parsing",
  classification: "ai-classification",
  embedding: "ai-embedding",
  extraction: "ai-extraction",
  analysis: "ai-analysis",
  preparation: "ai-preparation",
  validation: "ai-validation",
  maintenance: "ai-maintenance",
} as const;

export type AiQueueName = (typeof AI_QUEUES)[keyof typeof AI_QUEUES];

/** §10.4: exponential backoff, bounded attempts, bounded history. */
export const defaultJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

const queues = new Map<AiQueueName, Queue>();

export function getAiQueue(name: AiQueueName): Queue {
  const existing = queues.get(name);
  if (existing) return existing;
  const queue = new Queue(name, {
    connection: aiRedisOptions(),
    prefix: aiEnv().redisPrefix,
    defaultJobOptions,
  });
  queues.set(name, queue);
  return queue;
}

export async function closeAiQueues(): Promise<void> {
  const open = [...queues.values()];
  queues.clear();
  await Promise.all(open.map((queue) => queue.close()));
}
