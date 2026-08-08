/**
 * Chunk + embed every FETCHED tender document with extracted text. The
 * ai-indexer worker's sweep does the same thing continuously for fresh
 * fetches; this script drains the entire existing backlog in one run and
 * prints progress. Restart-safe: DONE ledger rows are skipped.
 *
 *   npm run ai:backfill:chunks
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getIngestionDb, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const { processDocumentChunks } = await import(
  "../lib/ai/chunking/doc-processor.ts"
);
const { embedDocumentChunks } = await import(
  "../lib/ai/embedding/chunk-embedder.ts"
);
const { getAiCollections } = await import("../lib/ai/db/collections.ts");

const db = await getIngestionDb();
const records = db.collection("tender_documents");

try {
  const total = await records.countDocuments({
    status: "FETCHED",
    "files.textStatus": "DONE",
  });
  console.log(`[ai-backfill-chunks] ${total} fetched documents with text`);

  const cursor = records.find(
    { status: "FETCHED", "files.textStatus": "DONE" },
    // Newest documents first — matches the worker sweeps' ordering.
    { projection: { _id: 1 }, sort: { updatedAt: -1 } },
  );

  let processed = 0;
  let failedDocs = 0;
  for await (const row of cursor) {
    const id = String(row._id);
    try {
      const chunkedFiles = await processDocumentChunks(id);
      for (const sha of chunkedFiles) {
        await embedDocumentChunks(id, sha);
      }
    } catch (error) {
      failedDocs += 1;
      console.error(`[ai-backfill-chunks] failed ${id}: ${String(error)}`);
    }
    processed += 1;
    if (processed % 25 === 0 || processed === total) {
      console.log(`[ai-backfill-chunks] ${processed}/${total} documents processed`);
    }
  }

  const { chunks, aiIndexState } = await getAiCollections();
  const chunkCount = await chunks.countDocuments();
  const embeddedCount = await chunks.countDocuments({
    embedding: { $exists: true, $not: { $size: 0 } },
  });
  const failedStates = await aiIndexState.countDocuments({ status: "FAILED" });
  console.log(
    `[ai-backfill-chunks] done: chunks=${chunkCount} embedded=${embeddedCount} failedDocs=${failedDocs} failedFiles=${failedStates}`,
  );
} finally {
  await closeIngestionClient();
}
