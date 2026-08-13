/**
 * Phase 2 of the Supabase → MongoDB migration: bring in the tenders the
 * migrated customers actually care about.
 *
 * The original plan called for a 24-month backfill, which means half a million
 * notices to serve a few hundred saved ones. This fetches only the notices the
 * migrating users reference — saved, set aside, or on a workspace board — and
 * leaves everything else to normal live ingestion.
 *
 * Each notice is fetched as eForms XML and handed to the real pipeline via
 * `processNoticeJob`, so it is parsed, hashed, raw-stored and committed exactly
 * like a notice discovered from a day archive. Nothing about the tender shape is
 * hand-built here. The German adapter refuses to fetch a single notice by design
 * (a normal refetch would re-download the whole archive), so the bytes are
 * handed to it as `inlinePayload`.
 *
 *   npm run migrate:tenders -- [--dry-run] [--limit 20] [--rpm 60] [--force]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { fetchAll } = await import("../lib/migration/source.ts");
const {
  dedupeReferences,
  noticeUiUrl,
  noticeXmlUrl,
  procedureCanonicalKey,
  toTenderReference,
} = await import("../lib/migration/tenders.ts");
const { getIngestionDb, closeIngestionClient } = await import(
  "../lib/ingestion/db/client.ts"
);
const { getSourceConfig } = await import(
  "../lib/ingestion/scheduler/source-configs.ts"
);
const { processNoticeJob } = await import(
  "../lib/ingestion/pipeline/process-notice.ts"
);
const { closeRedisConnections } = await import("../lib/ingestion/queue/client.ts");
const { finishProcess } = await import("../lib/ingestion/utils/exit.ts");

type LegacyTenderRow = import("../lib/migration/tenders.ts").LegacyTenderRow;
type TenderReference = import("../lib/migration/tenders.ts").TenderReference;
type CohortReport = import("../lib/migration/cohort.ts").CohortReport;
type DiscoveredNotice = import("../lib/ingestion/types.ts").DiscoveredNotice;
type NoticeJob = import("../lib/ingestion/types.ts").NoticeJob;

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const force = has("force");
const limit = Number.parseInt(flag("limit") ?? "0", 10) || 0;
// The source config allows 20/min for bulk archives; single notices are far
// cheaper, but stay polite — this is someone else's public service.
const rpm = Number.parseInt(flag("rpm") ?? "60", 10) || 60;
const delayMs = Math.ceil(60_000 / Math.max(rpm, 1));

const REPORT_DIR = path.join(process.cwd(), "docs", "migration-docs", "reports");

const cohort = JSON.parse(
  await readFile(path.join(REPORT_DIR, "cohort.json"), "utf8"),
) as CohortReport;
if (!cohort.signedOffBy) {
  throw new Error("cohort is not signed off — see docs/migration-docs/cohort-overrides.json");
}

interface PhaseThreeReport {
  companies: Array<{ domain: string; legacyIds: string[] }>;
}
const phaseThree = JSON.parse(
  await readFile(path.join(REPORT_DIR, "phase-03-companies.json"), "utf8"),
) as PhaseThreeReport;
const legacyCompanyIds = phaseThree.companies.flatMap((company) => company.legacyIds);

console.log(
  `resolving tenders referenced by ${phaseThree.companies.length} migrated companies` +
    `${dryRun ? " [dry run: nothing will be written]" : ""}`,
);

// Everything the migrated users pointed at: saved, set aside, or on a board.
const [saved, disliked, workspaces, workspaceTenders] = await Promise.all([
  fetchAll<{ tender_id: string | null }>(
    `user_saved_tenders?select=tender_id&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAll<{ tender_id: string | null }>(
    `user_disliked_tenders?select=tender_id&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAll<{ id: string }>(
    `work_space?select=id&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAll<{ tender_id: string | null; work_space_id: string | null }>(
    "work_space_tender?select=tender_id,work_space_id",
  ),
]);

const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
const legacyTenderIds = [
  ...new Set(
    [
      ...saved.map((row) => row.tender_id),
      ...disliked.map((row) => row.tender_id),
      ...workspaceTenders
        .filter((row) => row.work_space_id && workspaceIds.has(row.work_space_id))
        .map((row) => row.tender_id),
    ].filter((id): id is string => Boolean(id)),
  ),
];

console.log(
  `  saved=${saved.length} disliked=${disliked.length} ` +
    `workspace=${workspaceTenders.filter((r) => r.work_space_id && workspaceIds.has(r.work_space_id)).length}` +
    ` → ${legacyTenderIds.length} distinct tenders`,
);

// PostgREST caps the URL length, so resolve the tender rows in batches.
const rows: LegacyTenderRow[] = [];
for (let index = 0; index < legacyTenderIds.length; index += 60) {
  const batch = legacyTenderIds.slice(index, index + 60);
  rows.push(
    ...(await fetchAll<LegacyTenderRow>(
      `eforms_tenders_simplified_duplicate?select=id,notice_id,contract_folder_id,publication_date,xml_url&id=in.(${batch.join(",")})`,
    )),
  );
}

const references = dedupeReferences(
  rows
    .map(toTenderReference)
    .filter((reference): reference is TenderReference => reference !== null),
);
console.log(`  resolved ${rows.length} rows → ${references.length} distinct notices`);

const database = await getIngestionDb();
const tenders = database.collection("tenders");

/** Already-ingested notices are skipped; live ingestion keeps them current. */
async function alreadyPresent(reference: TenderReference): Promise<boolean> {
  if (
    await tenders.findOne(
      { "noticeRefs.sourceNoticeId": reference.sourceNoticeId },
      { projection: { _id: 1 } },
    )
  ) {
    return true;
  }
  if (!reference.procedureId) return false;
  return Boolean(
    await tenders.findOne(
      { canonicalKey: procedureCanonicalKey(reference.procedureId) },
      { projection: { _id: 1 } },
    ),
  );
}

const missing: TenderReference[] = [];
let present = 0;
for (const reference of references) {
  if (!force && (await alreadyPresent(reference))) present += 1;
  else missing.push(reference);
}

const targets = limit ? missing.slice(0, limit) : missing;
console.log(
  `  already in the corpus: ${present} · missing: ${missing.length}` +
    `${limit ? ` (processing ${targets.length})` : ""}`,
);

interface Failure {
  sourceNoticeId: string;
  reason: string;
}

const ingested: string[] = [];
/** Parsed but rejected by validation — stored, but not usable as a tender. */
const quarantined: string[] = [];
const failures: Failure[] = [];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fetches the notice XML, falling back to the legacy mirror if the source 404s. */
async function fetchNoticeXml(
  reference: TenderReference,
): Promise<{ body: Buffer; url: string }> {
  const attempts = [noticeXmlUrl(reference.sourceNoticeId)];
  if (reference.fallbackXmlUrl) attempts.push(reference.fallbackXmlUrl);

  let lastError = "no attempt made";
  for (const url of attempts) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/xml,text/xml,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        lastError = `HTTP ${response.status} from ${url}`;
        continue;
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.byteLength === 0) {
        lastError = `empty body from ${url}`;
        continue;
      }
      return { body, url };
    } catch (error) {
      lastError = `${error instanceof Error ? error.message : String(error)} (${url})`;
    }
  }
  throw new Error(lastError);
}

try {
  const config = await getSourceConfig("DE_BUND");
  if (!config) throw new Error("no DE_BUND source config — run ingestion:bootstrap first");

  for (const [index, reference] of targets.entries()) {
    try {
      const { body } = await fetchNoticeXml(reference);

      const notice: DiscoveredNotice = {
        source: "DE_BUND",
        sourceNoticeId: reference.sourceNoticeId,
        sourceVersionId: null,
        // Null lets the pipeline derive the version from the content hash,
        // which is what the archive path does for these notices too.
        versionKey: null,
        publicationNumber: null,
        procedureId: reference.procedureId,
        // The notice page a user clicks through to, matching what the archive
        // path records — deliberately not the XML endpoint we fetched from.
        url: noticeUiUrl(reference.sourceNoticeId),
        publishedAt: reference.publishedAt,
        updatedAtSource: null,
        // The adapter refuses to fetch one notice on its own, so hand it the
        // bytes exactly as a day archive would.
        inlinePayload: { body, mimeType: "application/xml" },
      };

      const job: NoticeJob = {
        kind: "notice",
        source: "DE_BUND",
        mode: "backfill",
        jobKey: `DE_BUND:${reference.sourceNoticeId}:migration`,
        notice,
        runId: null,
        attempt: 0,
      };

      if (dryRun) {
        ingested.push(reference.sourceNoticeId);
      } else {
        const result = await processNoticeJob(job, config);
        // The pipeline throws on failure; a quarantine is the one non-fatal
        // outcome that still means the tender is not usable.
        if (result.outcome === "QUARANTINED") {
          quarantined.push(reference.sourceNoticeId);
        } else {
          ingested.push(reference.sourceNoticeId);
        }
      }
    } catch (error) {
      failures.push({
        sourceNoticeId: reference.sourceNoticeId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if ((index + 1) % 25 === 0 || index + 1 === targets.length) {
      console.log(
        `  ${index + 1}/${targets.length} (ingested ${ingested.length}, failed ${failures.length})`,
      );
    }
    if (!dryRun && index + 1 < targets.length) await sleep(delayMs);
  }
} finally {
  await closeIngestionClient();
  await closeRedisConnections();
}

for (const failure of failures.slice(0, 20)) {
  console.warn(`  FAILED ${failure.sourceNoticeId}: ${failure.reason}`);
}
if (failures.length > 20) console.warn(`  … and ${failures.length - 20} more`);

console.log(
  `\nreferenced ${references.length} · already present ${present} · ` +
    `ingested ${ingested.length} · quarantined ${quarantined.length} · ` +
    `failed ${failures.length}`,
);

if (!dryRun) {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-02-tenders.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        phase: "02-tenders",
        ranAt: new Date().toISOString(),
        signedOffBy: cohort.signedOffBy,
        totals: {
          referenced: references.length,
          alreadyPresent: present,
          ingested: ingested.length,
          quarantined: quarantined.length,
          failed: failures.length,
        },
        quarantined,
        failures,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${reportPath}`);
  console.log("\nNext: Phase 5 maps saved/board state onto these tenders.");
}

finishProcess(failures.length > 0 && ingested.length === 0 ? 1 : 0);
