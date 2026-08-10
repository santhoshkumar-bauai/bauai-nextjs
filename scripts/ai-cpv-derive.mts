/**
 * Derives CPV codes for open tenders the buyer published without any —
 * ~14% of the open corpus, invisible to every CPV-based ranking mechanism.
 *
 * Candidate codes come from a `$text` search over the CPV catalog; a model
 * picks from that shortlist under an enum constraint (it cannot invent a
 * code) and may honestly refuse. Results land in `derivedCpv` (audit) and
 * `derivedCpvCodes` (read by the relevance pipeline, confidence ≥ medium
 * only). Source `cpvCodes` are never touched.
 *
 * Idempotent: every attempt — including refusals — is stamped with
 * CPV_DERIVE_VERSION and skipped on rerun. Throttled to AI_EXTRACTION_RPM.
 *
 *   npm run ai:cpv:derive -- [--limit 100] [--dry-run] [--force] [--purge]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getIngestionDb, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const { aiEnv } = await import("../lib/ai/config/env.ts");
const {
  assembleQueryText,
  CPV_DERIVE_VERSION,
  deriveAndPersist,
} = await import("../lib/ai/match/cpv-derive.ts");
const { OPPORTUNITY_STATUSES } = await import("../lib/tenders/relevance.ts");

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const limit = Number.parseInt(flag("limit") ?? "0", 10) || 0;
const dryRun = has("dry-run");
const force = has("force");

const db = await getIngestionDb();
const tenders = db.collection("tenders");

try {
  if (has("purge")) {
    const result = await tenders.updateMany(
      { derivedCpv: { $exists: true } },
      { $unset: { derivedCpv: "", derivedCpvCodes: "" } },
    );
    console.log(`purged derived CPV fields from ${result.modifiedCount} tenders`);
    process.exit(0);
  }

  // The relevance recall $or needs this index on every branch — create it
  // here too so a standalone script run cannot leave it missing.
  await tenders.createIndex({ derivedCpvCodes: 1 }, { name: "ix_derived_cpv" });

  const filter: Record<string, unknown> = {
    isVisible: true,
    status: { $in: [...OPPORTUNITY_STATUSES] },
    $or: [{ cpvCodes: { $size: 0 } }, { cpvCodes: null }],
    ...(force ? {} : { "derivedCpv.version": { $ne: CPV_DERIVE_VERSION } }),
  };

  const total = await tenders.countDocuments(filter);
  console.log(
    `${total} open uncoded tenders ${force ? "(force: re-deriving all)" : "not yet derived"}` +
      `${limit ? `, processing up to ${limit}` : ""}${dryRun ? " [dry run]" : ""}`,
  );

  const cursor = tenders
    .find(filter)
    .project({ title: 1, description: 1, lots: 1 })
    .sort({ publicationDate: -1 });
  if (limit) cursor.limit(limit);

  // One model call per tender; pace to the extraction budget so a long run
  // does not starve interactive extraction/judging of the same quota.
  const minIntervalMs = Math.ceil(60_000 / aiEnv().extractionRpm);
  let processed = 0;
  let applied = 0;
  let refused = 0;
  let failed = 0;

  for await (const tender of cursor) {
    const started = Date.now();
    try {
      if (dryRun) {
        console.log(
          `- would derive ${tender._id}: ${assembleQueryText(tender as never).split("\n")[0]?.slice(0, 90)}`,
        );
      } else {
        const result = await deriveAndPersist(db, tender as never);
        if (result.applied) applied += 1;
        else refused += 1;
        console.log(
          `- ${tender._id} [${result.confidence}${result.applied ? "" : ", not applied"}] ${result.codes.join(", ") || "(none)"}`,
        );
      }
    } catch (error) {
      failed += 1;
      console.error(`- ${tender._id} FAILED: ${error instanceof Error ? error.message : error}`);
    }
    processed += 1;
    if (processed % 50 === 0) {
      console.log(`… ${processed}/${limit || total} (applied ${applied}, refused ${refused}, failed ${failed})`);
    }
    if (!dryRun) {
      const elapsed = Date.now() - started;
      if (elapsed < minIntervalMs) {
        await new Promise((resolve) => setTimeout(resolve, minIntervalMs - elapsed));
      }
    }
  }

  console.log(
    `\ndone: ${processed} processed, ${applied} applied, ${refused} refused/low-confidence, ${failed} failed`,
  );
} finally {
  await closeIngestionClient();
}
