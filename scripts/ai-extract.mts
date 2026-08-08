/**
 * Batch extraction runner — extracts schemas for selected tenders INLINE (no
 * worker needed), with the same ledger idempotency as the queue path.
 *
 *   npm run ai:extract -- --tender <id>
 *   npm run ai:extract -- --tenders 3                 # top by chunk volume
 *   npm run ai:extract -- --tenders 3 --schemas deadlines,payment_terms
 *   npm run ai:extract -- --tender <id> --force       # ignore DONE ledger
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ObjectId } = await import("mongodb");
const { getAiCollections } = await import("../lib/ai/db/collections.ts");
const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");
const { extractSchemaForTender } = await import("../lib/ai/extraction/extractor.ts");
const { computeCorpusHash, saveExtraction } = await import(
  "../lib/ai/extraction/store.ts"
);
const { PROMPT_VERSION } = await import("../lib/ai/extraction/prompts.ts");
const { EXTRACTION_SCHEMA_NAMES, EXTRACTION_SCHEMAS } = await import(
  "../lib/ai/extraction/schemas/index.ts"
);
const { extractSchemaJobId } = await import("../lib/ai/queue/jobs.ts");

type SchemaName = (typeof EXTRACTION_SCHEMA_NAMES)[number];

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const tenderArg = argValue("--tender");
const tenderCount = Number(argValue("--tenders") ?? "1");
const force = process.argv.includes("--force");
const schemaArg = argValue("--schemas");
const schemaNames: SchemaName[] = schemaArg
  ? (schemaArg.split(",").filter((name) =>
      (EXTRACTION_SCHEMA_NAMES as readonly string[]).includes(name),
    ) as SchemaName[])
  : [...EXTRACTION_SCHEMA_NAMES];

try {
  const { chunks, aiIndexState } = await getAiCollections();

  const tenderIds: InstanceType<typeof ObjectId>[] = [];
  if (tenderArg) {
    tenderIds.push(new ObjectId(tenderArg));
  } else {
    const top = await chunks
      .aggregate<{ _id: InstanceType<typeof ObjectId>; n: number }>([
        { $match: { embedding: { $not: { $size: 0 } } } },
        { $group: { _id: "$tenderId", n: { $sum: 1 } } },
        { $sort: { n: -1 } },
        { $limit: tenderCount },
      ])
      .toArray();
    tenderIds.push(...top.map((row) => row._id));
    console.log(
      `[ai-extract] selected: ${top.map((r) => `${r._id} (${r.n} chunks)`).join(", ")}`,
    );
  }

  let totalCalls = 0;
  for (const tenderId of tenderIds) {
    const corpusHash = await computeCorpusHash(tenderId);
    console.log(`\n[ai-extract] tender ${tenderId} corpus=${corpusHash.slice(0, 12)}`);

    for (const schemaName of schemaNames) {
      const schema = EXTRACTION_SCHEMAS[schemaName];
      const stateId = extractSchemaJobId({
        tenderId: String(tenderId),
        schemaName,
        schemaVersion: schema.schemaVersion,
        promptVersion: PROMPT_VERSION,
        corpusHash,
      });

      if (!force) {
        const state = await aiIndexState.findOne({ _id: stateId });
        if (state?.status === "DONE") {
          console.log(`  ${schemaName}: skipped (already extracted for this corpus)`);
          continue;
        }
      }

      try {
        const outcome = await extractSchemaForTender({ tenderId, schemaName });
        await saveExtraction({ tenderId, outcome, corpusHash });
        await aiIndexState.updateOne(
          { _id: stateId },
          {
            $set: {
              kind: "extract_schema",
              refId: String(tenderId),
              sourceHash: corpusHash,
              status: "DONE",
              error: null,
              updatedAt: new Date(),
            },
            $inc: { attempts: 1 },
            $setOnInsert: { chunkCount: null },
          },
          { upsert: true },
        );
        totalCalls += outcome.stats.modelCalls;
        console.log(
          `  ${schemaName}: ${outcome.status} verified=${outcome.stats.verifiedFields}/${outcome.stats.totalFields} calls=${outcome.stats.modelCalls} retried=${outcome.stats.retriedFields} unresolved=[${outcome.unresolved.join(", ")}]`,
        );
      } catch (error) {
        console.error(`  ${schemaName}: FAILED — ${String(error)}`);
      }
    }
  }
  console.log(`\n[ai-extract] total model calls: ${totalCalls}`);
} finally {
  await closeIngestionClient();
}
