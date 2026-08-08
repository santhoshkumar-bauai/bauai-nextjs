/**
 * Retrieval evaluation over the canonical §17.5 questions against real
 * embedded tenders. Selects the N tenders with the most embedded chunks
 * (or a specific one via --tender <id>), grades every answerable question in
 * every mode, and prints a per-mode summary plus a JSON report.
 *
 *   npm run ai:eval
 *   npm run ai:eval -- --tender 6a75cb6069759cd96e3dd39d --modes hybrid
 *   npm run ai:eval -- --tenders 5 --json report.json
 */
import { writeFileSync } from "node:fs";

import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ObjectId } = await import("mongodb");
const { getAiCollections } = await import("../lib/ai/db/collections.ts");
const { closeIngestionClient } = await import("../lib/ingestion/db/client.ts");
const { CANONICAL_QUESTIONS } = await import("../lib/ai/eval/questions.ts");
const { answerableQuestions, runQuestion, summarize } = await import(
  "../lib/ai/eval/runner.ts"
);

type Mode = "keyword" | "vector" | "hybrid";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}

const tenderArg = argValue("--tender");
const tenderCount = Number(argValue("--tenders") ?? "3");
const modes = (argValue("--modes")?.split(",") as Mode[] | undefined) ?? [
  "keyword",
  "vector",
  "hybrid",
];
const jsonPath = argValue("--json");
const K = 10;

try {
  const { chunks } = await getAiCollections();

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
      `[ai-eval] selected ${tenderIds.length} tenders by chunk volume: ${top
        .map((row) => `${row._id} (${row.n})`)
        .join(", ")}`,
    );
  }

  if (tenderIds.length === 0) {
    console.error("[ai-eval] no embedded chunks found — run ai:backfill:chunks first");
    process.exit(1);
  }

  const results = [];
  for (const tenderId of tenderIds) {
    const answerable = await answerableQuestions(tenderId);
    console.log(
      `[ai-eval] tender ${tenderId}: ${answerable.size}/${CANONICAL_QUESTIONS.length} questions answerable`,
    );
    for (const question of CANONICAL_QUESTIONS) {
      if (!answerable.has(question.id)) continue;
      for (const mode of modes) {
        for (const language of ["de", "en"] as const) {
          const result = await runQuestion({
            question,
            language,
            mode,
            tenderId,
            tenantId: null,
            k: K,
          });
          results.push(result);
          const rank =
            result.firstRelevantRank === null
              ? "miss"
              : `rank ${result.firstRelevantRank}`;
          console.log(
            `  [${mode}/${language}] ${question.id}: ${rank} (${result.latencyMs}ms)`,
          );
        }
      }
    }
  }

  console.log("\n=== Summary ===");
  console.log("mode     lang  n    hit@1  hit@5  hit@10  MRR    latency");
  const summaries = [];
  for (const mode of modes) {
    for (const language of ["de", "en"] as const) {
      const summary = summarize(results, mode, language);
      summaries.push(summary);
      if (summary.questions === 0) continue;
      console.log(
        [
          mode.padEnd(8),
          language.padEnd(5),
          String(summary.questions).padEnd(4),
          summary.hitAt1.toFixed(2).padEnd(6),
          summary.hitAt5.toFixed(2).padEnd(6),
          summary.hitAt10.toFixed(2).padEnd(7),
          summary.mrr.toFixed(3).padEnd(6),
          `${summary.meanLatencyMs}ms`,
        ].join(" "),
      );
    }
  }

  if (jsonPath) {
    writeFileSync(
      jsonPath,
      JSON.stringify({ generatedAt: new Date().toISOString(), summaries, results }, null, 2),
    );
    console.log(`\n[ai-eval] report written to ${jsonPath}`);
  }
} finally {
  await closeIngestionClient();
}
