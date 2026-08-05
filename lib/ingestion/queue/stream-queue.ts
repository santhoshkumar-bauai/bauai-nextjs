import type Redis from "ioredis";

import { ingestionEnv } from "../config/env.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { IngestionJob, QueueName } from "../types.ts";
import { consumerGroup, seenKey, streamKey } from "./channels.ts";
import { createRedis } from "./client.ts";
import { decodeJob, encodeJob } from "./job-codec.ts";

const log = logger.child("queue");

/**
 * Durable at-least-once queue on Redis Streams.
 *
 * Architecture section 5.1 requires visibility timeouts, heartbeat extension,
 * stable job keys, and safe redelivery. Redis Streams consumer groups provide
 * all four through the pending-entries list: a message stays pending until it is
 * acknowledged, and any worker may reclaim it once it exceeds the visibility
 * timeout. Plain Redis pub/sub cannot do this — a message delivered to a worker
 * that then crashes is simply lost — so pub/sub is used only for the outbox
 * fan-out in `outbox/relay.ts`, where loss is recoverable from MongoDB.
 */
export interface ReservedMessage {
  id: string;
  queue: QueueName;
  job: IngestionJob;
  /** Redis delivery counter; 1 on first delivery. */
  attempt: number;
}

export interface QueueStats {
  queue: QueueName;
  length: number;
  pending: number;
  oldestAgeMs: number;
}

const SEEN_TTL_SECONDS = 60 * 60 * 24 * 3;
/** Safety net only; entries are deleted on ack, so the stream stays short. */
const STREAM_MAXLEN = 5_000_000;

export class StreamQueue {
  private readonly consumerName: string;
  private readonly producer: Redis;
  private readonly consumer: Redis;
  private readonly ensured = new Set<QueueName>();

  constructor(consumerName: string = ingestionEnv.workerId) {
    this.consumerName = consumerName;
    this.producer = createRedis("queue-producer");
    this.consumer = createRedis("queue-consumer");
  }

  /** Consumer groups must exist before the first read; MKSTREAM creates both. */
  private async ensureGroup(queue: QueueName): Promise<void> {
    if (this.ensured.has(queue)) return;
    try {
      await this.producer.xgroup("CREATE", streamKey(queue), consumerGroup, "0", "MKSTREAM");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("BUSYGROUP")) throw error;
    }
    this.ensured.add(queue);
  }

  /**
   * Enqueues a job unless its stable key was already accepted. Deduplication is
   * what makes an overlap window cheap: the same notice rediscovered every poll
   * is dropped here instead of costing a fetch and a MongoDB round trip (§4.1).
   *
   * Returns false when the job was a duplicate.
   */
  async enqueue(queue: QueueName, job: IngestionJob): Promise<boolean> {
    await this.ensureGroup(queue);

    const claimed = await this.producer.set(
      `${seenKey(queue)}:${job.jobKey}`,
      "1",
      "EX",
      SEEN_TTL_SECONDS,
      "NX",
    );
    if (claimed === null) {
      metrics.increment("ingestion_jobs_deduplicated_total", {
        queue,
        source: job.source,
      });
      return false;
    }

    await this.producer.xadd(
      streamKey(queue),
      "MAXLEN",
      "~",
      String(STREAM_MAXLEN),
      "*",
      "payload",
      encodeJob(job),
      "jobKey",
      job.jobKey,
    );

    metrics.increment("ingestion_jobs_enqueued_total", {
      queue,
      source: job.source,
      mode: job.mode,
    });
    return true;
  }

  async enqueueMany(queue: QueueName, jobs: IngestionJob[]): Promise<number> {
    let accepted = 0;
    for (const job of jobs) {
      if (await this.enqueue(queue, job)) accepted += 1;
    }
    return accepted;
  }

  /**
   * Claims up to `count` new messages. Blocks only on the first queue in the
   * caller's priority list so higher-priority work is never starved by a long
   * block on a lower-priority stream.
   */
  async reserve(
    queue: QueueName,
    count: number,
    blockMs: number,
  ): Promise<ReservedMessage[]> {
    await this.ensureGroup(queue);

    const response = (await this.consumer.xreadgroup(
      "GROUP",
      consumerGroup,
      this.consumerName,
      "COUNT",
      count,
      "BLOCK",
      blockMs,
      "STREAMS",
      streamKey(queue),
      ">",
    )) as Array<[string, Array<[string, string[]]>]> | null;

    if (!response?.length) return [];
    return this.decode(queue, response[0][1], 1);
  }

  /**
   * Recovers messages whose owner died or exceeded the visibility timeout.
   * XPENDING gives the delivery counter, which the pipeline uses to decide
   * between another retry and the dead-letter queue (§11.1).
   */
  async reclaimStalled(queue: QueueName, count: number): Promise<ReservedMessage[]> {
    await this.ensureGroup(queue);

    const pending = (await this.consumer.xpending(
      streamKey(queue),
      consumerGroup,
      "IDLE",
      ingestionEnv.worker.visibilityTimeoutMs,
      "-",
      "+",
      count,
    )) as Array<[string, string, number, number]> | null;

    if (!pending?.length) return [];

    const reclaimed: ReservedMessage[] = [];
    for (const [id, , , deliveryCount] of pending) {
      const claimed = (await this.consumer.xclaim(
        streamKey(queue),
        consumerGroup,
        this.consumerName,
        ingestionEnv.worker.visibilityTimeoutMs,
        id,
      )) as Array<[string, string[]]>;

      // An empty result means another worker won the race, or the entry was
      // already acknowledged and deleted. Both are safe to skip.
      if (!claimed?.length) continue;
      reclaimed.push(...this.decode(queue, claimed, deliveryCount + 1));
    }

    if (reclaimed.length) {
      metrics.increment(
        "ingestion_jobs_reclaimed_total",
        { queue },
        reclaimed.length,
      );
      log.warn("reclaimed stalled jobs", { queue, count: reclaimed.length });
    }
    return reclaimed;
  }

  /**
   * Extends ownership of an in-flight message without inflating its retry
   * counter, which is the heartbeat the architecture asks for on long jobs.
   */
  async heartbeat(queue: QueueName, message: ReservedMessage): Promise<void> {
    await this.consumer.xclaim(
      streamKey(queue),
      consumerGroup,
      this.consumerName,
      0,
      message.id,
      "JUSTID",
      "RETRYCOUNT",
      message.attempt,
    );
  }

  /** Acknowledge and delete. Deleting keeps memory bounded on high volume days. */
  async ack(queue: QueueName, id: string): Promise<void> {
    const key = streamKey(queue);
    await this.consumer
      .multi()
      .xack(key, consumerGroup, id)
      .xdel(key, id)
      .exec();
  }

  /**
   * Returns a message for later delivery. The entry is acknowledged and re-added
   * so the delay is honoured without holding a pending entry open, and the seen
   * key is cleared so the re-add is not treated as a duplicate.
   */
  async retryLater(
    queue: QueueName,
    message: ReservedMessage,
    delayMs: number,
  ): Promise<void> {
    await this.ack(queue, message.id);
    await this.producer.del(`${seenKey(queue)}:${message.job.jobKey}`);

    const job: IngestionJob = { ...message.job, attempt: message.attempt };
    metrics.increment("ingestion_jobs_retried_total", {
      queue,
      source: job.source,
    });

    if (delayMs <= 0) {
      await this.enqueue(queue, job);
      return;
    }

    // A sorted set is the delay line; `promoteDueRetries` moves entries back
    // into the stream once they are due, so a restart cannot lose them.
    await this.producer.zadd(
      this.retryKey(queue),
      Date.now() + delayMs,
      encodeJob(job),
    );
  }

  /** Moves due delayed retries back onto the stream. Called on each worker tick. */
  async promoteDueRetries(queue: QueueName, limit = 100): Promise<number> {
    const due = await this.producer.zrangebyscore(
      this.retryKey(queue),
      "-inf",
      Date.now(),
      "LIMIT",
      0,
      limit,
    );
    if (!due.length) return 0;

    let promoted = 0;
    for (const raw of due) {
      // Only the worker that wins the removal re-enqueues, so concurrent
      // workers cannot promote the same retry twice.
      const removed = await this.producer.zrem(this.retryKey(queue), raw);
      if (removed !== 1) continue;
      try {
        await this.enqueue(queue, decodeJob(raw));
        promoted += 1;
      } catch (error) {
        log.error("failed to promote retry", { queue, error: String(error) });
      }
    }
    return promoted;
  }

  /**
   * Clears the deduplication key for a job key. Dead-letter replay needs this,
   * otherwise a replayed notice would be silently dropped as already seen (§11.3).
   */
  async forget(queue: QueueName, jobKey: string): Promise<void> {
    await this.producer.del(`${seenKey(queue)}:${jobKey}`);
  }

  async stats(queue: QueueName): Promise<QueueStats> {
    await this.ensureGroup(queue);
    const key = streamKey(queue);

    const [length, groups] = await Promise.all([
      this.producer.xlen(key),
      this.producer.xinfo("GROUPS", key) as Promise<unknown[]>,
    ]);

    let pending = 0;
    for (const group of groups) {
      const flat = group as unknown[];
      const nameIndex = flat.indexOf("name");
      const pendingIndex = flat.indexOf("pending");
      if (flat[nameIndex + 1] === consumerGroup && pendingIndex >= 0) {
        pending = Number(flat[pendingIndex + 1]) || 0;
      }
    }

    // Stream ids are `<unixMillis>-<sequence>`, so the first entry's id is the
    // age of the oldest unprocessed job — the section 15.3 queue-age alert.
    const first = (await this.producer.xrange(key, "-", "+", "COUNT", 1)) as Array<
      [string, string[]]
    >;
    const oldestAgeMs = first?.length
      ? Math.max(0, Date.now() - Number(first[0][0].split("-")[0]))
      : 0;

    metrics.gauge("ingestion_queue_depth", length, { queue });
    metrics.gauge("ingestion_queue_pending", pending, { queue });
    metrics.gauge("ingestion_queue_oldest_age_ms", oldestAgeMs, { queue });

    return { queue, length, pending, oldestAgeMs };
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.producer.quit(), this.consumer.quit()]);
  }

  private retryKey(queue: QueueName): string {
    return `${streamKey(queue)}:retry`;
  }

  private decode(
    queue: QueueName,
    entries: Array<[string, string[]]>,
    attempt: number,
  ): ReservedMessage[] {
    const messages: ReservedMessage[] = [];
    for (const [id, fields] of entries) {
      const payloadIndex = fields.indexOf("payload");
      if (payloadIndex < 0) {
        log.error("stream entry without payload; dropping", { queue, id });
        void this.ack(queue, id);
        continue;
      }
      try {
        messages.push({
          id,
          queue,
          job: decodeJob(fields[payloadIndex + 1]),
          attempt,
        });
      } catch (error) {
        log.error("unparseable stream entry; dropping", {
          queue,
          id,
          error: String(error),
        });
        void this.ack(queue, id);
      }
    }
    return messages;
  }
}
