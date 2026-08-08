import { ObjectId, type AnyBulkWriteOperation, type Collection } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import type { EnrichmentState, TenderDocument } from "../../ingestion/types.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { getGateway } from "../gateway/index.ts";
import type { NoticeEmbedJob } from "../queue/jobs.ts";
import type { TenderSearchDocument } from "../types.ts";
import { buildSearchDocument } from "./search-document.ts";

const log = logger.child("ai.notice-indexer");

export interface EmbedBatchResult {
  done: number;
  skipped: number;
  failed: number;
}

/**
 * Embeds a batch of tender notices in one pass: tenders → curated search
 * documents → ONE `batchEmbedContents` call (the whole point of batching:
 * 44k notices are ~700 API calls instead of 44k) → bulk upsert into
 * `tender_search_documents` → `enrichment.embedding` ledger transition.
 *
 * Replay-safe per §10.3: rows whose sourceHash + model + version already
 * match are skipped (their ledger is still marked DONE, which is what heals
 * a crash between the upsert and the ledger write).
 */
export async function embedNoticeBatch(
  tenderIds: ObjectId[],
): Promise<EmbedBatchResult> {
  if (tenderIds.length === 0) return { done: 0, skipped: 0, failed: 0 };

  const db = await getIngestionDb();
  const tenders = db.collection<TenderDocument>("tenders");
  const { tenderSearchDocuments } = await getAiCollections();
  const gateway = getGateway();

  const docs = await tenders.find({ _id: { $in: tenderIds } }).toArray();
  const built = docs.map((tender) => ({ tender, built: buildSearchDocument(tender) }));

  // Partition into up-to-date rows and rows needing an embedding call.
  const existing = await tenderSearchDocuments
    .find(
      { tenderId: { $in: docs.map((d) => d._id) } },
      { projection: { tenderId: 1, sourceHash: 1, embeddingModel: 1, embeddingVersion: 1 } },
    )
    .toArray();
  const existingByTender = new Map(
    existing.map((row) => [String(row.tenderId), row]),
  );

  const toEmbed: typeof built = [];
  const upToDate: ObjectId[] = [];
  // Skip check compares against the configured identity, which the gateway
  // stamps onto every result — no probe call needed.
  const env = aiEnv();

  for (const item of built) {
    const row = existingByTender.get(String(item.tender._id));
    if (
      row &&
      row.sourceHash === item.built.sourceHash &&
      row.embeddingModel === env.embeddingModel &&
      row.embeddingVersion === env.embeddingVersion
    ) {
      upToDate.push(item.tender._id);
    } else {
      toEmbed.push(item);
    }
  }

  let done = 0;
  const failedIds: ObjectId[] = [];

  if (toEmbed.length > 0) {
    try {
      const embedded = await gateway.embed({
        texts: toEmbed.map((item) => item.built.text),
        taskType: "RETRIEVAL_DOCUMENT",
      });

      const now = new Date();
      const ops: AnyBulkWriteOperation<TenderSearchDocument>[] = toEmbed.map(
        (item, index) => ({
          updateOne: {
            filter: { tenderId: item.tender._id },
            update: {
              $set: {
                canonicalKey: item.tender.canonicalKey,
                language: item.built.language,
                text: item.built.text,
                filters: item.built.filters,
                embedding: embedded.vectors[index],
                embeddingModel: embedded.model,
                embeddingVersion: embedded.version,
                embeddingDimensions: embedded.dimensions,
                sourceHash: item.built.sourceHash,
                indexedAt: now,
                updatedAt: now,
              },
              $setOnInsert: { tenderId: item.tender._id, createdAt: now },
            },
            upsert: true,
          },
        }),
      );
      await tenderSearchDocuments.bulkWrite(ops, { ordered: false });
      done = toEmbed.length;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error("batch embed failed", { size: toEmbed.length, error: message });
      failedIds.push(...toEmbed.map((item) => item.tender._id));
      await markEmbedding(tenders, failedIds, {
        status: "FAILED",
        updatedAt: new Date(),
        error: message.slice(0, 500),
      });
      // Ledger records the failure; rethrow so callers (queue/backoff) react.
      throw error;
    }
  }

  const doneIds = [
    ...upToDate,
    ...toEmbed.map((item) => item.tender._id),
  ];
  if (doneIds.length > 0) {
    await markEmbedding(tenders, doneIds, { status: "DONE", updatedAt: new Date() });
  }

  // Tenders deleted between enqueue and processing simply drop out of `docs`.
  return { done, skipped: upToDate.length, failed: failedIds.length };
}

/** Queue-path processor: one tender per job (outbox push latency path). */
export async function processNoticeEmbedJob(job: NoticeEmbedJob): Promise<void> {
  await embedNoticeBatch([new ObjectId(job.tenderId)]);
}

function markEmbedding(
  tenders: Collection<TenderDocument>,
  tenderIds: ObjectId[],
  state: EnrichmentState,
): Promise<unknown> {
  return tenders.updateMany(
    { _id: { $in: tenderIds } },
    { $set: { "enrichment.embedding": state, updatedAt: new Date() } },
  );
}
