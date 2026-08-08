import { randomUUID } from "node:crypto";

import type { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { subscribeToTenderChanges } from "../../ingestion/outbox/subscriber.ts";
import type { TenderDocument } from "../../ingestion/types.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { noticeEmbedJobId, type NoticeEmbedJob } from "../queue/jobs.ts";
import { AI_QUEUES, getAiQueue } from "../queue/queues.ts";

const log = logger.child("ai.embedding.producers");

const SWEEP_INTERVAL_MS = 30_000;
/** Pause between inline batches so a full backfill cannot starve the event loop. */
const BATCH_PAUSE_MS = 250;

/**
 * Two producers, one guarantee (the relay's own design, §5.1):
 *
 * - `sweepPendingNotices` — the completeness AND throughput path. The
 *   `enrichment.embedding.status` ledger on `tenders` is swept and embedded
 *   INLINE in `embeddingBatchSize` groups: one `batchEmbedContents` call per
 *   group turns the 44k backfill into ~700 API calls instead of 44k queued
 *   singles. FAILED rows are retried once per sweep interval (a 30s natural
 *   cooldown); stale DONE rows (older model/version) are re-embedded last.
 * - `subscribeOutboxChannel` — the latency path. A pub/sub hint enqueues the
 *   single changed tender on the BullMQ queue immediately; a lost message is
 *   caught by the next sweep, a duplicate is a no-op via the sourceHash check.
 */

async function enqueueNotice(tenderId: ObjectId | string): Promise<void> {
  const env = aiEnv();
  const job: NoticeEmbedJob = {
    kind: "notice_embed",
    tenderId: String(tenderId),
    embeddingModel: env.embeddingModel,
    embeddingVersion: env.embeddingVersion,
    actorId: "system",
    correlationId: randomUUID(),
    attempt: 0,
  };
  await getAiQueue(AI_QUEUES.embedding).add("notice_embed", job, {
    jobId: noticeEmbedJobId(job),
  });
}

export async function sweepPendingNotices(signal: AbortSignal): Promise<void> {
  const env = aiEnv();
  const db = await getIngestionDb();
  const tenders = db.collection<TenderDocument>("tenders");
  const { embedNoticeBatch } = await import("./notice-indexer.ts");

  async function drain(status: "PENDING" | "FAILED"): Promise<number> {
    let processed = 0;
    for (;;) {
      if (signal.aborted) return processed;
      const batch = await tenders
        .find(
          { "enrichment.embedding.status": status },
          {
            projection: { _id: 1 },
            sort: { lastSeenAt: -1 },
            limit: env.embeddingBatchSize,
          },
        )
        .toArray();
      if (batch.length === 0) return processed;

      try {
        const result = await embedNoticeBatch(batch.map((row) => row._id));
        processed += result.done + result.skipped;
        log.info("sweep embedded batch", { status, ...result });
      } catch (error) {
        log.error("sweep batch failed", { status, error: String(error) });
        // The failed rows are now FAILED in the ledger; stop draining this
        // status until the next interval instead of hot-looping on them.
        return processed;
      }
      // FAILED rows: one batch per interval is enough — they were failing
      // moments ago, give the cause time to clear.
      if (status === "FAILED") return processed;

      await sleep(BATCH_PAUSE_MS, signal);
    }
  }

  while (!signal.aborted) {
    try {
      await drain("PENDING");
      await drain("FAILED");

      // Re-embed DONE rows written by an older model/version. The search-doc
      // collection stores the identity; embedNoticeBatch handles the rest.
      const { tenderSearchDocuments } = await getAiCollections();
      const stale = await tenderSearchDocuments
        .find(
          {
            $or: [
              { embeddingModel: { $ne: env.embeddingModel } },
              { embeddingVersion: { $ne: env.embeddingVersion } },
            ],
          },
          { projection: { tenderId: 1 }, limit: env.embeddingBatchSize },
        )
        .toArray();
      if (stale.length > 0) {
        const result = await embedNoticeBatch(stale.map((row) => row.tenderId));
        log.info("sweep re-embedded stale batch", { ...result });
      }
    } catch (error) {
      log.error("sweep iteration failed", { error: String(error) });
    }

    await sleep(SWEEP_INTERVAL_MS, signal);
  }
}

export async function subscribeOutboxChannel(signal: AbortSignal): Promise<void> {
  const unsubscribe = subscribeToTenderChanges({
    signal,
    onEvent: async (event) => {
      try {
        await enqueueNotice(event.aggregateId);
      } catch (error) {
        // The sweep is the safety net; a failed hint is only a latency loss.
        log.warn("failed to enqueue from outbox hint", {
          aggregateId: event.aggregateId,
          error: String(error),
        });
      }
    },
    onError: (error) => {
      log.warn("outbox subscription error", { error: String(error) });
    },
  });

  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
  unsubscribe();
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
