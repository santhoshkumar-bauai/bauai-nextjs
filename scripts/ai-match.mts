/**
 * Runs one AI match refresh in-process and prints the result.
 *
 * The dev/ops tool for the matching pipeline: it is how you eyeball whether
 * the top of a company's feed is sane after a weight change, and how you
 * recover a company whose refresh failed with no worker running.
 *
 *   npm run ai:match -- --company <id> [--top 20] [--all]
 *   npm run ai:match -- --all
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { ObjectId } = await import("mongodb");
const { getIngestionDb, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const { getAiCollections } = await import("../lib/ai/db/collections.ts");
const { aiEnv } = await import("../lib/ai/config/env.ts");
const { claimRun, getRun } = await import("../lib/ai/match/runs.ts");
const { refreshCompanyMatches, toRunError } = await import(
  "../lib/ai/match/service.ts"
);
const { embeddingIdentity, getMatchProfileState } = await import(
  "../lib/ai/match/company-profile.ts"
);
const { MATCH_JUDGE_PROMPT_VERSION } = await import("../lib/ai/match/schema.ts");

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const top = Number.parseInt(flag("top") ?? "20", 10) || 20;
const env = aiEnv();

const db = await getIngestionDb();
const companyId = flag("company");
const companies = await db
  .collection<{ _id: InstanceType<typeof ObjectId>; name?: string }>("companies")
  .find(companyId ? { _id: new ObjectId(companyId) } : {})
  .project<{ _id: InstanceType<typeof ObjectId>; name?: string }>({ name: 1 })
  .toArray();

if (companies.length === 0) {
  console.error("no companies matched; pass --company <id> or seed one first");
  process.exit(1);
}
const targets = companyId || has("all") ? companies : companies.slice(0, 1);

for (const company of targets) {
  const tenantId = company._id;
  console.log(`\n=== ${company.name ?? "(unnamed)"} ${tenantId.toHexString()} ===`);

  const { companyDataHash } = await getMatchProfileState(tenantId);
  const claimed = await claimRun({
    tenantId,
    companyDataHash,
    promptVersion: MATCH_JUDGE_PROMPT_VERSION,
    pipelineVersion: env.matchPipelineVersion,
    embeddingIdentity: embeddingIdentity(),
    trigger: "manual",
    userId: null,
  });
  if (!claimed) {
    console.error("a refresh is already running for this company; skipping");
    continue;
  }

  const startedAt = Date.now();
  try {
    const result = await refreshCompanyMatches({
      tenantId,
      runId: claimed.runId,
    });
    console.log(
      `facets=${result.facetCount} scored=${result.scoredCount} judged=${result.judgedCount} in ${Math.round((Date.now() - startedAt) / 1000)}s`,
    );
  } catch (error) {
    console.error(`FAILED (${toRunError(error)}):`, error);
    continue;
  }

  const { companyMatchProfiles, tenderMatchScores } = await getAiCollections();
  const profile = await companyMatchProfiles.findOne({ tenantId });
  console.log(
    "facets:",
    profile?.facets
      .map((facet) => `${facet.key}(w=${facet.weight.toFixed(2)})`)
      .join(", ") || "none",
  );
  if (profile?.skipped.length) {
    console.log(
      "skipped:",
      profile.skipped.map((entry) => `${entry.key}:${entry.reason}`).join(", "),
    );
  }

  const run = await getRun(tenantId);
  const rows = await tenderMatchScores
    .aggregate([
      { $match: { tenantId, runId: run?.lastCompletedRunId } },
      { $sort: { finalScore: -1 } },
      { $limit: top },
      {
        $lookup: {
          from: "tenders",
          localField: "tenderId",
          foreignField: "_id",
          as: "tender",
        },
      },
      { $unwind: "$tender" },
      {
        $project: {
          title: "$tender.title",
          cpvCodes: "$tender.cpvCodes",
          regions: "$tender.regions",
          finalScore: 1,
          fitScore: 1,
          confidence: 1,
          signals: 1,
          matchedFacets: 1,
          reasons: 1,
          matchedCapabilities: 1,
          concerns: 1,
        },
      },
    ])
    .toArray();

  console.log(`\ntop ${rows.length}:`);
  for (const [index, row] of rows.entries()) {
    const facets = (row.matchedFacets as Array<{ key: string }>)
      .map((facet) => facet.key)
      .join(",");
    const signals = row.signals as Record<string, number>;
    const fit = row.fitScore == null ? " -- " : String(row.fitScore).padStart(3) + " ";
    console.log(
      `${String(index + 1).padStart(3)}. ${(row.finalScore as number).toFixed(3)} ` +
        `fit=${fit}(${row.confidence ?? "-"}) ` +
        `sem=${signals.semantic.toFixed(2)} cpv=${signals.cpv.toFixed(2)} ` +
        `txt=${(signals.text ?? 0).toFixed(2)} ` +
        `geo=${signals.geo.toFixed(2)} time=${signals.time.toFixed(2)} ` +
        `[${facets || "rule-only"}] ${String(row.title ?? "").slice(0, 70)}`,
    );
    const reasons = row.reasons as { en?: string } | null;
    if (reasons?.en) console.log(`      → ${reasons.en}`);
    const caps = (row.matchedCapabilities as string[]) ?? [];
    const concerns = (row.concerns as string[]) ?? [];
    if (caps.length || concerns.length) {
      console.log(
        `      + ${caps.join(", ") || "—"}${concerns.length ? `   ! ${concerns.join(", ")}` : ""}`,
      );
    }
  }
}

await closeIngestionClient();
