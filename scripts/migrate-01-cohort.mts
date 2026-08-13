/**
 * Phase 1 of the Supabase → MongoDB migration: decide which legacy tenants
 * actually migrate, and write the report a human signs off on.
 *
 * Read-only. It touches the legacy Supabase database and (best-effort) the
 * target Mongo, and writes nothing but the two report files. Every later phase
 * reads `cohort.json` and refuses to run until `signedOffBy` is filled in, so
 * this file is the gate for the whole migration.
 *
 * Two artifacts land in docs/migration-docs/reports/:
 *   cohort.json       — machine input for phases 3-7
 *   cohort-review.md  — the human-readable version to review and sign off
 *
 * The scoring rules live in lib/migration/cohort.ts and are unit tested; this
 * script is only I/O and assembly.
 *
 *   npm run migrate:cohort -- [--dry-run] [--recent-days 180]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient } = await import("mongodb");
const { fetchAll, fetchAuthUsers } = await import("../lib/migration/source.ts");
const { buildCohort } = await import("../lib/migration/cohort.ts");

type ActivityCounts = import("../lib/migration/cohort.ts").ActivityCounts;
type MemberCounts = import("../lib/migration/cohort.ts").MemberCounts;
type SourceCompany = import("../lib/migration/cohort.ts").SourceCompany;
type SourceProfile = import("../lib/migration/cohort.ts").SourceProfile;
type CohortReport = import("../lib/migration/cohort.ts").CohortReport;
type CohortOverrides = import("../lib/migration/cohort.ts").CohortOverrides;

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const recentDays = Number.parseInt(flag("recent-days") ?? "180", 10) || 180;

const MIGRATION_DIR = path.join(process.cwd(), "docs", "migration-docs");
const REPORT_DIR = path.join(MIGRATION_DIR, "reports");
const OVERRIDES_PATH = path.join(MIGRATION_DIR, "cohort-overrides.json");

/** Hand-maintained human decisions; absent on a first run, which is fine. */
async function loadOverrides(): Promise<{
  overrides: CohortOverrides;
  signedOffBy: string | null;
}> {
  try {
    const raw = await readFile(OVERRIDES_PATH, "utf8");
    const parsed = JSON.parse(raw) as {
      overrides?: CohortOverrides;
      signedOffBy?: string | null;
    };
    return {
      overrides: parsed.overrides ?? {},
      signedOffBy: parsed.signedOffBy ?? null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { overrides: {}, signedOffBy: null };
    }
    throw new Error(
      `could not read ${OVERRIDES_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function emptyActivity(): ActivityCounts {
  return {
    savedTenders: 0, dislikedTenders: 0, workspaceTenders: 0,
    chatSessions: 0, documents: 0, savedFilters: 0, extractedDocuments: 0,
  };
}

/** Increments one activity counter for a company, tolerating null ids. */
function bump(
  counts: Map<string, ActivityCounts>,
  companyId: string | null | undefined,
  key: keyof ActivityCounts,
): void {
  if (!companyId) return;
  const current = counts.get(companyId) ?? emptyActivity();
  current[key] += 1;
  counts.set(companyId, current);
}

console.log(
  `reading legacy Supabase data${dryRun ? " [dry run: no files written]" : ""}…`,
);

const [
  companies,
  profiles,
  authUsers,
  savedTenders,
  dislikedTenders,
  workspaces,
  workspaceTenders,
  chatSessions,
  documents,
  savedFilters,
  extractedDocuments,
] = await Promise.all([
  fetchAll<SourceCompany>(
    "companies?select=id,name,domain,company_domain,website,company_website,created_at",
  ),
  fetchAll<SourceProfile>(
    "profiles?select=id,company_id,is_onboarding_completed",
  ),
  fetchAuthUsers(),
  fetchAll<{ company_id: string | null }>("user_saved_tenders?select=company_id"),
  fetchAll<{ company_id: string | null }>("user_disliked_tenders?select=company_id"),
  // work_space_tender carries no company_id, so the board rows are attributed
  // through their workspace.
  fetchAll<{ id: string; company_id: string | null }>("work_space?select=id,company_id"),
  fetchAll<{ work_space_id: string | null }>("work_space_tender?select=work_space_id"),
  fetchAll<{ company_id: string | null }>("chat_sessions?select=company_id"),
  fetchAll<{ company_id: string | null }>("documents?select=company_id"),
  fetchAll<{ company_id: string | null }>("saved_filter_profiles?select=company_id"),
  // The 4.3M rows with a null company_id are tender documents, not company
  // uploads — only the company-scoped ones are migration payload.
  fetchAll<{ company_id: string | null }>(
    "extracted_document?select=company_id&company_id=not.is.null",
  ),
]);

console.log(
  `  companies=${companies.length} profiles=${profiles.length} authUsers=${authUsers.length} ` +
    `saved=${savedTenders.length} disliked=${dislikedTenders.length} ` +
    `workspaceTenders=${workspaceTenders.length} chats=${chatSessions.length} ` +
    `documents=${documents.length} filters=${savedFilters.length} ` +
    `companyDocs=${extractedDocuments.length}`,
);

const activityByCompany = new Map<string, ActivityCounts>();
for (const row of savedTenders) bump(activityByCompany, row.company_id, "savedTenders");
for (const row of dislikedTenders) bump(activityByCompany, row.company_id, "dislikedTenders");
for (const row of chatSessions) bump(activityByCompany, row.company_id, "chatSessions");
for (const row of documents) bump(activityByCompany, row.company_id, "documents");
for (const row of savedFilters) bump(activityByCompany, row.company_id, "savedFilters");
for (const row of extractedDocuments) {
  bump(activityByCompany, row.company_id, "extractedDocuments");
}

const companyByWorkspace = new Map(
  workspaces.map((workspace) => [workspace.id, workspace.company_id]),
);
for (const row of workspaceTenders) {
  bump(
    activityByCompany,
    row.work_space_id ? companyByWorkspace.get(row.work_space_id) : null,
    "workspaceTenders",
  );
}

const authUserById = new Map(authUsers.map((user) => [user.id, user]));
const recentCutoff = Date.now() - recentDays * 24 * 60 * 60 * 1000;

const membershipByCompany = new Map<string, MemberCounts>();
for (const profile of profiles) {
  if (!profile.company_id) continue;
  const counts: MemberCounts =
    membershipByCompany.get(profile.company_id) ??
    { members: 0, signedIn: 0, recentlyActive: 0, onboarded: 0 };

  counts.members += 1;
  if (profile.is_onboarding_completed) counts.onboarded += 1;

  const lastSignIn = authUserById.get(profile.id)?.last_sign_in_at;
  if (lastSignIn) {
    counts.signedIn += 1;
    if (new Date(lastSignIn).getTime() >= recentCutoff) counts.recentlyActive += 1;
  }

  membershipByCompany.set(profile.company_id, counts);
}

const { overrides, signedOffBy } = await loadOverrides();
console.log(
  `  human overrides: ${Object.keys(overrides).length}` +
    `  ·  signed off by: ${signedOffBy ?? "(unsigned)"}`,
);

const report = buildCohort({
  companies,
  profiles,
  activityByCompany,
  membershipByCompany,
  overrides,
});
// Carried from the checked-in overrides file, which is the durable record.
report.signedOffBy = signedOffBy;

// Best-effort: flag tenants already present in the target so a re-run after a
// partial migration is legible. A missing Mongo must not fail Phase 1.
const alreadyMigrated = new Set<string>();
const mongoUri = process.env.MONGODB_URI;
if (mongoUri) {
  const client = new MongoClient(mongoUri);
  try {
    await client.connect();
    const existing = await client
      .db(process.env.MONGODB_DB || "bauai")
      .collection<{ domain?: string }>("companies")
      .find({}, { projection: { domain: 1 } })
      .toArray();
    for (const row of existing) {
      if (row.domain) alreadyMigrated.add(row.domain.toLowerCase());
    }
    console.log(`  target already holds ${alreadyMigrated.size} companies`);
  } catch (error) {
    console.warn(
      `  (skipped target check: ${error instanceof Error ? error.message : String(error)})`,
    );
  } finally {
    await client.close();
  }
}

const included = report.entries.filter((entry) => entry.decision === "include");
const review = report.entries.filter((entry) => entry.decision === "review");

console.log(
  `\ncohort: ${report.totals.include} include · ${report.totals.review} review · ` +
    `${report.totals.exclude} exclude  (of ${report.totals.sourceCompanies} companies)`,
);
console.log(`users in the include set: ${report.totals.usersInCohort}`);
console.log(`merge proposals: ${report.mergeProposals.length}`);

for (const entry of included) {
  console.log(
    `  include  ${entry.cleanedName.slice(0, 44).padEnd(45)} ` +
      `act=${String(entry.activityTotal).padStart(4)} members=${entry.membership.members}` +
      `${entry.mergeInto ? ` → merges into ${entry.mergeInto}` : ""}`,
  );
}
for (const entry of review) {
  console.log(
    `  REVIEW   ${entry.cleanedName.slice(0, 44).padEnd(45)} ` +
      `act=${String(entry.activityTotal).padStart(4)} members=${entry.membership.members}  (${entry.reason})`,
  );
}
for (const warning of report.warnings) {
  console.warn(`  WARNING  ${warning}`);
}
for (const proposal of report.mergeProposals) {
  const renamed =
    proposal.preferredName === proposal.survivorName
      ? ""
      : `  (rename to "${proposal.preferredName}")`;
  console.log(
    `  MERGE    ${proposal.survivorName} ← ${proposal.absorbedNames.join(", ")}${renamed}`,
  );
}

function toMarkdown(cohort: CohortReport): string {
  const row = (entry: (typeof cohort.entries)[number]) =>
    `| ${entry.cleanedName || "_(no name)_"} | ${entry.activityTotal} | ${entry.membership.members} | ` +
    `${entry.membership.signedIn} | ${entry.membership.recentlyActive} | ` +
    `${entry.activity.extractedDocuments} | ${entry.reason} |`;

  const header =
    "| Company | Activity | Members | Signed in | Active ≤180d | Docs | Reason |\n" +
    "|---|---:|---:|---:|---:|---:|---|";

  return [
    "# Migration cohort — review & sign-off",
    "",
    `Generated ${cohort.generatedAt} from the legacy Supabase database.`,
    "",
    "**To approve:** review the tables below, move any misfiled company between",
    "the include/exclude lists in `cohort.json`, then set `signedOffBy` in that",
    "file to your name. Phases 3-7 refuse to run while it is null.",
    "",
    `- **${cohort.totals.include}** companies to migrate (${cohort.totals.usersInCohort} users)`,
    `- **${cohort.totals.review}** need a human decision`,
    `- **${cohort.totals.exclude}** excluded of ${cohort.totals.sourceCompanies} total`,
    "",
    "## Include",
    "",
    header,
    ...cohort.entries.filter((entry) => entry.decision === "include").map(row),
    "",
    "## Needs review",
    "",
    "These have real activity but a name that does not prove they are a real firm —",
    "signup derived it from the user's email domain. Some are genuine customers.",
    "",
    header,
    ...cohort.entries.filter((entry) => entry.decision === "review").map(row),
    "",
    "## Proposed merges",
    "",
    cohort.mergeProposals.length === 0
      ? "_None._"
      : [
          "| Survivor (keeps the data) | Absorbs | Final name | Match key |",
          "|---|---|---|---|",
          ...cohort.mergeProposals.map(
            (proposal) =>
              `| ${proposal.survivorName} | ${proposal.absorbedNames.join(", ")} | ` +
              `${proposal.preferredName} | \`${proposal.matchKey}\` |`,
          ),
        ].join("\n"),
    "",
    "## Excluded",
    "",
    "Listed so an over-eager filter is caught at sign-off rather than after cutover.",
    "",
    header,
    ...cohort.entries.filter((entry) => entry.decision === "exclude").map(row),
    "",
  ].join("\n");
}

if (dryRun) {
  console.log("\n[dry run] would write cohort.json and cohort-review.md");
} else {
  await mkdir(REPORT_DIR, { recursive: true });
  const jsonPath = path.join(REPORT_DIR, "cohort.json");
  const markdownPath = path.join(REPORT_DIR, "cohort-review.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, toMarkdown(report), "utf8");
  console.log(`\nwrote ${jsonPath}`);
  console.log(`wrote ${markdownPath}`);
  console.log("\nNext: review cohort-review.md, then set signedOffBy in cohort.json.");
}
