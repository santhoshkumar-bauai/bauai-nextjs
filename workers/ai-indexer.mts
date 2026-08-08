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

const indexer = new AiIndexer();

indexer.registerProcessor("notice_embed", async (job) => {
  if (job.kind !== "notice_embed") return;
  await processNoticeEmbedJob(job);
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
