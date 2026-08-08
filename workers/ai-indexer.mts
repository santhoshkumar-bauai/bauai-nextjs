/**
 * AI indexer: hosts the BullMQ consumers for the AI queues plus the producers
 * that keep them fed — the enrichment-ledger sweep and the outbox pub/sub
 * subscription (§5.1 completeness + latency pattern).
 *
 *   npm run worker:ai
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { AiIndexer } = await import("../lib/ai/worker/indexer.ts");
const { runWorker } = await import("../lib/ingestion/worker/runtime.ts");
const { processNoticeEmbedJob } = await import(
  "../lib/ai/embedding/notice-indexer.ts"
);
const { sweepPendingNotices, subscribeOutboxChannel } = await import(
  "../lib/ai/embedding/producers.ts"
);
const { sweepFetchedDocuments } = await import(
  "../lib/ai/embedding/doc-producer.ts"
);

const { ObjectId } = await import("mongodb");
const { extractSchemaForTender } = await import("../lib/ai/extraction/extractor.ts");
const { saveExtraction } = await import("../lib/ai/extraction/store.ts");
const { extractSchemaJobId } = await import("../lib/ai/queue/jobs.ts");
const { getAiCollections } = await import("../lib/ai/db/collections.ts");
const { EXTRACTION_SCHEMA_NAMES } = await import(
  "../lib/ai/extraction/schemas/index.ts"
);

const indexer = new AiIndexer();

indexer.registerProcessor("notice_embed", async (job) => {
  if (job.kind !== "notice_embed") return;
  await processNoticeEmbedJob(job);
});

const { processCompanyDocEmbed } = await import(
  "../lib/ai/company/doc-embedder.ts"
);

indexer.registerProcessor("company_doc_embed", async (job) => {
  if (job.kind !== "company_doc_embed") return;
  await processCompanyDocEmbed(job);
});

indexer.registerProcessor("extract_schema", async (job) => {
  if (job.kind !== "extract_schema") return;
  const schemaName = EXTRACTION_SCHEMA_NAMES.find((n) => n === job.schemaName);
  if (!schemaName) throw new Error(`unknown extraction schema "${job.schemaName}"`);

  const { aiIndexState } = await getAiCollections();
  const stateId = extractSchemaJobId(job);
  await aiIndexState.updateOne(
    { _id: stateId },
    {
      $set: {
        kind: "extract_schema",
        refId: job.tenderId,
        sourceHash: job.corpusHash,
        status: "RUNNING",
        error: null,
        updatedAt: new Date(),
      },
      $inc: { attempts: 1 },
      $setOnInsert: { chunkCount: null },
    },
    { upsert: true },
  );

  try {
    const tenderId = new ObjectId(job.tenderId);
    const outcome = await extractSchemaForTender({ tenderId, schemaName });
    await saveExtraction({ tenderId, outcome, corpusHash: job.corpusHash });
    await aiIndexState.updateOne(
      { _id: stateId },
      { $set: { status: "DONE", error: null, updatedAt: new Date() } },
    );
  } catch (error) {
    await aiIndexState.updateOne(
      { _id: stateId },
      {
        $set: {
          status: "FAILED",
          error: String(error).slice(0, 500),
          updatedAt: new Date(),
        },
      },
    );
    // Rethrow: BullMQ backoff owns transient retries (rate limits, 5xx).
    throw error;
  }
});

indexer.registerProducer(sweepPendingNotices);
indexer.registerProducer(subscribeOutboxChannel);
indexer.registerProducer(sweepFetchedDocuments);

await runWorker({
  name: "ai-indexer",
  run: (signal) => indexer.start(signal),
  isHealthy: () => indexer.isHealthy(),
  cleanup: () => indexer.stop(),
});
