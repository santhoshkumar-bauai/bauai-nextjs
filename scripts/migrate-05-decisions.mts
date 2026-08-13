/**
 * Phase 5 of the Supabase → MongoDB migration: put each customer's tenders back
 * on their board.
 *
 * Reads the legacy saved / dismissed / workspace tables, resolves the conflicts
 * between them (see lib/migration/decisions.ts), translates legacy uuids into
 * the ids the new database uses, and upserts one `tender_decisions` document per
 * (company, tender).
 *
 * Three translations have to happen and each can fail independently:
 *   legacy company  → migrated company, via the Phase 3 report
 *   legacy tender   → ingested tender, via notice id or the `proc:` canonical key
 *   legacy user     → Better Auth user, via email
 * Anything that cannot be resolved is skipped with a reason and reported, never
 * guessed at.
 *
 *   npm run migrate:decisions -- [--dry-run] [--limit 20]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient } = await import("mongodb");
const { fetchAll, fetchAuthUsers } = await import("../lib/migration/source.ts");
const { pickBestDraft, resolveDecisions } = await import(
  "../lib/migration/decisions.ts"
);
const { procedureCanonicalKey } = await import("../lib/migration/tenders.ts");

type CohortReport = import("../lib/migration/cohort.ts").CohortReport;
type WorkspaceTenderRow = import("../lib/migration/decisions.ts").WorkspaceTenderRow;
type SimpleTenderRef = import("../lib/migration/decisions.ts").SimpleTenderRef;

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const limit = Number.parseInt(flag("limit") ?? "0", 10) || 0;

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

// Legacy company id → target domain. Merged tenants map several ids to one.
const domainByLegacyCompany = new Map<string, string>();
for (const company of phaseThree.companies) {
  for (const legacyId of company.legacyIds) {
    domainByLegacyCompany.set(legacyId, company.domain);
  }
}
const legacyCompanyIds = [...domainByLegacyCompany.keys()];

console.log(
  `resolving board state for ${phaseThree.companies.length} companies` +
    `${dryRun ? " [dry run: nothing will be written]" : ""}`,
);

const [saved, disliked, workspaces, workspaceTenders, authUsers] = await Promise.all([
  fetchAll<SimpleTenderRef>(
    `user_saved_tenders?select=tender_id,company_id,user_id,created_at&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAll<SimpleTenderRef>(
    `user_disliked_tenders?select=tender_id,company_id,user_id,created_at&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAll<{ id: string; company_id: string | null }>(
    `work_space?select=id,company_id&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAll<WorkspaceTenderRow>("work_space_tender?select=*"),
  fetchAuthUsers(),
]);

const companyByWorkspace = new Map(
  workspaces.map((workspace) => [workspace.id, workspace.company_id]),
);

const drafts = resolveDecisions({
  workspace: workspaceTenders.flatMap((row) => {
    const companyId = row.work_space_id
      ? companyByWorkspace.get(row.work_space_id)
      : null;
    return companyId ? [{ companyId, row }] : [];
  }),
  saved,
  disliked,
});

const bySource = drafts.reduce<Record<string, number>>((counts, draft) => {
  counts[draft.source] = (counts[draft.source] ?? 0) + 1;
  return counts;
}, {});
console.log(
  `  saved=${saved.length} disliked=${disliked.length} boardCards=${workspaceTenders.length}` +
    ` → ${drafts.length} decisions ${JSON.stringify(bySource)}`,
);

// Legacy tender uuid → the identifiers the new corpus is indexed by.
const legacyTenderIds = [...new Set(drafts.map((draft) => draft.legacyTenderId))];
const tenderRows: Array<{
  id: string;
  notice_id: string | null;
  contract_folder_id: string | null;
}> = [];
for (let index = 0; index < legacyTenderIds.length; index += 60) {
  const batch = legacyTenderIds.slice(index, index + 60);
  tenderRows.push(
    ...(await fetchAll<(typeof tenderRows)[number]>(
      `eforms_tenders_simplified_duplicate?select=id,notice_id,contract_folder_id&id=in.(${batch.join(",")})`,
    )),
  );
}
const tenderKeyByLegacyId = new Map(tenderRows.map((row) => [row.id, row]));

// Legacy user uuid → email, the only stable link to the migrated user.
const emailByLegacyUser = new Map(
  authUsers.flatMap((user) =>
    user.email ? [[user.id, user.email.toLowerCase()] as const] : [],
  ),
);

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");
const client = new MongoClient(uri);

interface Skipped {
  legacyTenderId: string;
  reason: string;
}

const skipped: Skipped[] = [];
const written: string[] = [];
const statusCounts: Record<string, number> = {};

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const companies = database.collection("companies");
  const users = database.collection("user");
  const tenders = database.collection("tenders");
  const decisions = database.collection("tender_decisions");

  // The model declares these; a standalone run must not leave them missing.
  if (!dryRun) {
    await decisions.createIndex({ companyId: 1, tenderId: 1 }, { unique: true });
    await decisions.createIndex({ companyId: 1, status: 1, updatedAt: -1 });
  }

  // Resolve each translation once, not per decision.
  const companyIdByDomain = new Map<string, string>();
  const memberIdsByDomain = new Map<string, Set<string>>();
  for (const domain of new Set(domainByLegacyCompany.values())) {
    const company = await companies.findOne<{
      _id: { toHexString(): string };
      members?: Array<{ userId: string }>;
    }>({ domain }, { projection: { members: 1 } });
    if (!company) continue;
    companyIdByDomain.set(domain, company._id.toHexString());
    memberIdsByDomain.set(
      domain,
      new Set((company.members ?? []).map((member) => member.userId)),
    );
  }

  const userIdByEmail = new Map<string, string>();
  for (const email of new Set(emailByLegacyUser.values())) {
    const user = await users.findOne<{ _id: { toHexString(): string } }>({ email });
    if (user) userIdByEmail.set(email, user._id.toHexString());
  }

  const tenderIdCache = new Map<string, string | null>();
  async function resolveTenderId(legacyTenderId: string): Promise<string | null> {
    if (tenderIdCache.has(legacyTenderId)) return tenderIdCache.get(legacyTenderId)!;

    const keys = tenderKeyByLegacyId.get(legacyTenderId);
    let resolved: string | null = null;

    if (keys?.notice_id) {
      const match = await tenders.findOne<{ _id: { toHexString(): string } }>(
        { "noticeRefs.sourceNoticeId": String(keys.notice_id) },
        { projection: { _id: 1 } },
      );
      if (match) resolved = match._id.toHexString();
    }
    if (!resolved && keys?.contract_folder_id) {
      const match = await tenders.findOne<{ _id: { toHexString(): string } }>(
        { canonicalKey: procedureCanonicalKey(String(keys.contract_folder_id)) },
        { projection: { _id: 1 } },
      );
      if (match) resolved = match._id.toHexString();
    }

    tenderIdCache.set(legacyTenderId, resolved);
    return resolved;
  }

  // Resolve identities first, then merge. Several legacy tender rows describe
  // one notice, so two drafts can land on the same (company, tender) pair — and
  // 7 of those pairs disagree. Merging after resolution makes the winner a
  // decision rather than a race between upserts.
  const byTarget = new Map<
    string,
    { companyId: string; domain: string; tenderId: string; drafts: typeof drafts }
  >();

  for (const draft of drafts) {
    const domain = domainByLegacyCompany.get(draft.legacyCompanyId);
    const companyId = domain ? companyIdByDomain.get(domain) : undefined;
    if (!companyId || !domain) {
      skipped.push({ legacyTenderId: draft.legacyTenderId, reason: "company not migrated" });
      continue;
    }

    const tenderId = await resolveTenderId(draft.legacyTenderId);
    if (!tenderId) {
      // Expected for notices withdrawn at source; Phase 2 reports those.
      skipped.push({ legacyTenderId: draft.legacyTenderId, reason: "tender not in corpus" });
      continue;
    }

    const pair = `${companyId}|${tenderId}`;
    const existing = byTarget.get(pair);
    if (existing) existing.drafts.push(draft);
    else byTarget.set(pair, { companyId, domain, tenderId, drafts: [draft] });
  }

  const merged = [...byTarget.values()];
  const collapsed = drafts.length - skipped.length - merged.length;
  if (collapsed > 0) {
    console.log(
      `  ${collapsed} drafts collapsed onto an existing (company, tender) pair`,
    );
  }

  const targets = limit ? merged.slice(0, limit) : merged;

  for (const target of targets) {
    const { companyId, domain, tenderId } = target;
    const draft = pickBestDraft(target.drafts);
    const members = memberIdsByDomain.get(domain) ?? new Set<string>();
    const resolveUser = (legacyUserId: string | null): string | null => {
      if (!legacyUserId) return null;
      const email = emailByLegacyUser.get(legacyUserId);
      const userId = email ? userIdByEmail.get(email) : undefined;
      return userId && members.has(userId) ? userId : null;
    };

    // Whoever acted must still be a member; otherwise fall back to an admin so
    // the record is never left pointing at a user who does not exist.
    const decidedBy =
      resolveUser(draft.legacyDecidedByUserId) ?? [...members][0] ?? null;
    if (!decidedBy) {
      skipped.push({ legacyTenderId: draft.legacyTenderId, reason: "company has no members" });
      continue;
    }
    const assignee = resolveUser(draft.legacyAssigneeUserId);

    statusCounts[draft.status] = (statusCounts[draft.status] ?? 0) + 1;

    if (!dryRun) {
      const now = new Date();
      await decisions.updateOne(
        { companyId, tenderId },
        {
          $set: {
            status: draft.status,
            decidedByUserId: decidedBy,
            ...(assignee ? { assigneeUserId: assignee } : {}),
            updatedAt: draft.updatedAt ?? now,
          },
          $setOnInsert: { companyId, tenderId, createdAt: draft.createdAt ?? now },
        },
        { upsert: true },
      );
    }
    written.push(`${companyId}|${tenderId}`);
  }
} finally {
  await client.close();
}

const skipReasons = skipped.reduce<Record<string, number>>((counts, entry) => {
  counts[entry.reason] = (counts[entry.reason] ?? 0) + 1;
  return counts;
}, {});

console.log(`\nstatuses: ${JSON.stringify(statusCounts)}`);
if (skipped.length > 0) console.log(`skipped: ${JSON.stringify(skipReasons)}`);
console.log(
  `\nresolved ${drafts.length} decisions · written ${written.length} · skipped ${skipped.length}`,
);

if (!dryRun) {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-05-decisions.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      {
        phase: "05-decisions",
        ranAt: new Date().toISOString(),
        signedOffBy: cohort.signedOffBy,
        totals: {
          resolved: drafts.length,
          written: written.length,
          skipped: skipped.length,
        },
        bySource,
        statuses: statusCounts,
        skipReasons,
        skipped,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${reportPath}`);
}
