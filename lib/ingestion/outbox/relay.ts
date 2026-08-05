import type { ChangeStream, ChangeStreamInsertDocument, ResumeToken } from "mongodb";

import { ingestionEnv } from "../config/env.ts";
import { getIngestionDb } from "../db/client.ts";
import { collectionNames, getCollections } from "../db/collections.ts";
import { describeError, logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import { createRedis } from "../queue/client.ts";
import type { OutboxEventDocument } from "../types.ts";
import { exponentialBackoffMs, sleep } from "../utils/time.ts";

const log = logger.child("outbox");

const RELAY_STATE_ID = "outbox-relay";

/**
 * Publishes committed tender changes to the application.
 *
 * Architecture section 5.1: the outbox exists because notifying before the commit
 * can announce a tender that was never saved. A change stream only sees
 * majority-committed inserts, so anything this relay publishes is durable.
 *
 * Redis pub/sub is the right transport *here* — unlike the work queue — because
 * the authoritative record stays in `outbox_events`. A subscriber that misses a
 * message loses a push, not the data, and the sweeper redelivers it.
 */
export class OutboxRelay {
  private readonly publisher = createRedis("outbox-publisher");
  private stream: ChangeStream<OutboxEventDocument> | null = null;
  private stopped = false;
  private lastPublishedAt = Date.now();

  async start(signal: AbortSignal): Promise<void> {
    signal.addEventListener("abort", () => void this.stop(), { once: true });

    // The sweeper covers both retries and anything the change stream missed while
    // this process was down, so the two together are complete.
    const sweeper = this.runSweeper(signal);
    const watcher = this.runWatcher(signal);
    await Promise.allSettled([watcher, sweeper]);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.stream?.close().catch(() => undefined);
    this.stream = null;
  }

  isHealthy(): boolean {
    return !this.stopped;
  }

  private async runWatcher(signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (!this.stopped && !signal.aborted) {
      try {
        const db = await getIngestionDb();
        const resumeToken = await this.loadResumeToken();

        this.stream = db
          .collection<OutboxEventDocument>(collectionNames.outboxEvents)
          .watch([{ $match: { operationType: "insert" } }], {
            fullDocument: "required",
            // Resuming avoids republishing history on every restart; without a
            // token the relay starts from now and the sweeper backfills the gap.
            ...(resumeToken ? { resumeAfter: resumeToken } : {}),
          });

        log.info("outbox change stream open", { resumed: Boolean(resumeToken) });
        attempt = 0;

        for await (const change of this.stream) {
          const insert = change as ChangeStreamInsertDocument<OutboxEventDocument>;
          await this.deliver(insert.fullDocument);
          await this.saveResumeToken(this.stream.resumeToken);
          if (this.stopped || signal.aborted) break;
        }
      } catch (error) {
        if (this.stopped || signal.aborted) return;
        attempt += 1;
        const delay = exponentialBackoffMs(attempt, 1_000);
        log.error("outbox change stream failed; reopening", {
          ...describeError(error),
          attempt,
          delayMs: delay,
        });
        metrics.increment("ingestion_outbox_stream_errors_total");
        await sleep(delay, signal);
      }
    }
  }

  /**
   * Retries undelivered events and reports delivery lag. This is what makes the
   * relay safe across restarts and what the section 15.3 lag alert reads.
   */
  private async runSweeper(signal: AbortSignal): Promise<void> {
    const collections = await getCollections();

    while (!this.stopped && !signal.aborted) {
      try {
        const now = new Date();
        const pending = await collections.outboxEvents
          .find({ deliveredAt: null, nextAttemptAt: { $lte: now } })
          .sort({ createdAt: 1 })
          .limit(ingestionEnv.outbox.batchSize)
          .toArray();

        for (const event of pending) {
          await this.deliver(event);
        }

        const oldest = await collections.outboxEvents
          .find({ deliveredAt: null })
          .sort({ createdAt: 1 })
          .limit(1)
          .toArray();
        const lagMs = oldest.length ? Date.now() - oldest[0].createdAt.getTime() : 0;
        metrics.gauge("ingestion_outbox_lag_ms", lagMs);
      } catch (error) {
        log.error("outbox sweep failed", describeError(error));
      }
      await sleep(ingestionEnv.outbox.sweepIntervalMs, signal);
    }
  }

  /**
   * Publishes one event and marks it delivered. Publishing before marking means a
   * crash in between causes a duplicate push, never a lost one; subscribers key on
   * `aggregateId` + `aggregateVersion` to ignore repeats.
   */
  private async deliver(event: OutboxEventDocument): Promise<void> {
    const collections = await getCollections();

    // Shadow mode reconciles MongoDB writes without touching the live app (§18.3).
    if (ingestionEnv.shadowMode) {
      await collections.outboxEvents.updateOne(
        { _id: event._id, deliveredAt: null },
        { $set: { deliveredAt: new Date(), lastError: "shadow-mode" } },
      );
      return;
    }

    try {
      const receivers = await this.publisher.publish(
        ingestionEnv.outbox.channel,
        JSON.stringify({
          eventType: event.eventType,
          aggregateId: event.aggregateId.toHexString(),
          aggregateVersion: event.aggregateVersion,
          ...event.payload,
          emittedAt: new Date().toISOString(),
        }),
      );

      const updated = await collections.outboxEvents.updateOne(
        { _id: event._id, deliveredAt: null },
        { $set: { deliveredAt: new Date() }, $inc: { attempts: 1 } },
      );

      if (updated.modifiedCount) {
        this.lastPublishedAt = Date.now();
        metrics.increment("ingestion_outbox_delivered_total", {
          eventType: event.eventType,
        });
        metrics.gauge("ingestion_outbox_subscribers", receivers);
      }
    } catch (error) {
      const described = describeError(error);
      const attempts = event.attempts + 1;
      const exhausted = attempts >= ingestionEnv.outbox.maxAttempts;

      await collections.outboxEvents.updateOne(
        { _id: event._id },
        {
          $set: {
            attempts,
            nextAttemptAt: new Date(Date.now() + exponentialBackoffMs(attempts, 5_000)),
            lastError: described.message.slice(0, 500),
          },
        },
      );

      log.error("outbox delivery failed", {
        ...described,
        aggregateId: event.aggregateId.toHexString(),
        attempts,
        exhausted,
      });
      metrics.increment("ingestion_outbox_failures_total", {
        eventType: event.eventType,
      });
    }
  }

  private async loadResumeToken(): Promise<ResumeToken | null> {
    const collections = await getCollections();
    const state = await collections.relayState.findOne({ _id: RELAY_STATE_ID });
    return (state?.resumeToken as ResumeToken | undefined) ?? null;
  }

  private async saveResumeToken(token: ResumeToken | undefined): Promise<void> {
    if (!token) return;
    const collections = await getCollections();
    await collections.relayState.updateOne(
      { _id: RELAY_STATE_ID },
      { $set: { resumeToken: token, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  msSinceLastPublish(): number {
    return Date.now() - this.lastPublishedAt;
  }
}

/**
 * Removes delivered events once past the audit-retention period. Section 6.7
 * requires archiving only *after* that window, so the default is deliberately
 * generous and configurable.
 */
export async function pruneDeliveredOutboxEvents(
  retentionDays = Number.parseInt(process.env.INGESTION_OUTBOX_RETENTION_DAYS ?? "30", 10),
): Promise<number> {
  const collections = await getCollections();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const result = await collections.outboxEvents.deleteMany({
    deliveredAt: { $ne: null, $lt: cutoff },
  });
  return result.deletedCount;
}
