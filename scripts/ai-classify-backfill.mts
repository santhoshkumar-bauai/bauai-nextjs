/**
 * Classifies every chunked document file that has no docClass yet.
 * Heuristics-first; LLM fallback unless --llm=false (dry pass to gauge how
 * many files would need model calls). Restart-safe via the ai_index_state
 * ledger.
 *
 *   npm run ai:classify:backfill
 *   npm run ai:classify:backfill -- --llm=false --limit 100
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getAiCollections } = await import("../lib/ai/db/collections.ts");
const { classifyDocumentFile } = await import("../lib/ai/classification/classifier.ts");
const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");

const allowModel = !process.argv.includes("--llm=false");
const limitIndex = process.argv.indexOf("--limit");
const limit = limitIndex >= 0 ? Number(process.argv[limitIndex + 1]) : Infinity;

const { chunks, documentClassifications } = await getAiCollections();

try {
  const targets = await chunks
    .aggregate<{ _id: { documentRecordId: string; fileSha256: string } }>([
      { $match: { docClass: null } },
      { $group: { _id: { documentRecordId: "$documentRecordId", fileSha256: "$fileSha256" } } },
    ])
    .toArray();
  console.log(`[ai-classify] ${targets.length} unclassified files (llm=${allowModel})`);

  const tally = new Map<string, number>();
  let processed = 0;
  let llmCalls = 0;
  let skippedDry = 0;

  for (const target of targets) {
    if (processed >= limit) break;
    const result = await classifyDocumentFile(
      target._id.documentRecordId,
      target._id.fileSha256,
      { allowModel },
    );
    processed += 1;
    if (!result) {
      skippedDry += 1;
    } else {
      tally.set(result.docClass, (tally.get(result.docClass) ?? 0) + 1);
      if (result.method === "llm") llmCalls += 1;
    }
    if (processed % 100 === 0) {
      console.log(`[ai-classify] ${processed}/${Math.min(targets.length, limit)}`);
    }
  }

  console.log("\nPer-class tally:");
  for (const [docClass, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${docClass.padEnd(28)} ${count}`);
  }
  console.log(
    `\nprocessed=${processed} llmCalls=${llmCalls}` +
      (allowModel ? "" : ` unresolvedWithoutLlm=${skippedDry}`),
  );
  const total = await documentClassifications.countDocuments();
  const stillNull = await chunks.countDocuments({ docClass: null });
  console.log(`classifications total=${total}; chunks with docClass=null remaining=${stillNull}`);
} finally {
  await closeIngestionClient();
}
