/**
 * Notice-embedding backfill monitor. The ai-indexer worker's sweep does the
 * actual enqueueing; this script watches the ledger converge and reports
 * queue depth, throughput, and the Gemini call estimate.
 *
 *   npm run ai:backfill:notices            # print status once
 *   npm run ai:backfill:notices -- --watch # refresh every 15s until done
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getIngestionDb, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const { getAiCollections } = await import("../lib/ai/db/collections.ts");
const { AI_QUEUES, getAiQueue, closeAiQueues } = await import(
  "../lib/ai/queue/queues.ts"
);
const { aiEnv } = await import("../lib/ai/config/env.ts");

const watch = process.argv.includes("--watch");
const env = aiEnv();

async function report(): Promise<{ pending: number; failed: number }> {
  const db = await getIngestionDb();
  const byStatus = await db
    .collection("tenders")
    .aggregate<{ _id: string | null; n: number }>([
      { $group: { _id: "$enrichment.embedding.status", n: { $sum: 1 } } },
    ])
    .toArray();
  const counts = new Map(byStatus.map((row) => [row._id ?? "MISSING", row.n]));
  const { tenderSearchDocuments } = await getAiCollections();
  const indexed = await tenderSearchDocuments.countDocuments();
  const queue = getAiQueue(AI_QUEUES.embedding);
  const queueCounts = await queue.getJobCounts(
    "waiting",
    "active",
    "delayed",
    "failed",
  );

  const pending = counts.get("PENDING") ?? 0;
  const failed = counts.get("FAILED") ?? 0;
  const done = counts.get("DONE") ?? 0;

  console.log(
    [
      `[${new Date().toISOString()}]`,
      `ledger: done=${done} pending=${pending} failed=${failed}`,
      `search_docs=${indexed}`,
      `queue: waiting=${queueCounts.waiting} active=${queueCounts.active} delayed=${queueCounts.delayed} failed=${queueCounts.failed}`,
      `est. remaining API batches=${Math.ceil(pending / env.embeddingBatchSize)}`,
    ].join("  "),
  );
  return { pending, failed };
}

try {
  if (!watch) {
    await report();
  } else {
    for (;;) {
      const { pending } = await report();
      const queue = getAiQueue(AI_QUEUES.embedding);
      const { waiting, active, delayed } = await queue.getJobCounts(
        "waiting",
        "active",
        "delayed",
      );
      if (pending === 0 && waiting === 0 && active === 0 && delayed === 0) {
        console.log("backfill complete");
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    }
  }
} finally {
  await closeAiQueues();
  await closeIngestionClient();
}
