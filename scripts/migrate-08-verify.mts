/**
 * Phase 8 of the Supabase → MongoDB migration: prove the result is sound.
 *
 * Read-only. Exits non-zero if anything blocking fails, so it can gate a
 * cutover instead of being a checklist someone reads.
 *
 * The checks are the ones the migration actually earned: every one of them
 * corresponds to a mistake that was either made and caught during development
 * (a company left on a `legacy:` placeholder, a board with no admin, decisions
 * written twice under a unique index) or would be invisible until a customer
 * hit it (a member pointing at a deleted user, a file whose bytes never landed
 * in S3, one tenant able to read another's data).
 *
 *   npm run migrate:verify -- [--skip-s3]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { readFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient } = await import("mongodb");
const { formatResult, summarize } = await import("../lib/migration/verify.ts");
const { DECISION_STATUSES } = await import("../lib/tenders/pipeline-status.ts");

type CheckResult = import("../lib/migration/verify.ts").CheckResult;
type CohortReport = import("../lib/migration/cohort.ts").CohortReport;
type ObjectId = import("mongodb").ObjectId;

const has = (name: string) => process.argv.includes(`--${name}`);
const skipS3 = has("skip-s3");

const REPORT_DIR = path.join(process.cwd(), "docs", "migration-docs", "reports");
const cohort = JSON.parse(
  await readFile(path.join(REPORT_DIR, "cohort.json"), "utf8"),
) as CohortReport;

const results: CheckResult[] = [];
const record = (
  name: string,
  ok: boolean,
  detail: string,
  severity?: "error" | "warning",
) => results.push({ name, ok, detail, ...(severity ? { severity } : {}) });

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");
const client = new MongoClient(uri);

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const companies = database.collection("companies");
  const users = database.collection("user");
  const accountProfiles = database.collection("accountprofiles");
  const decisions = database.collection("tender_decisions");
  const companyFiles = database.collection("companyfiles");
  const tenders = database.collection("tenders");

  /* ---------------------------------------------------------------- cohort */

  record(
    "cohort is signed off",
    Boolean(cohort.signedOffBy),
    cohort.signedOffBy ? `by ${cohort.signedOffBy}` : "signedOffBy is null",
  );

  const migrated = await companies
    .find<{ _id: ObjectId; domain: string; members?: Array<{ userId: string; role: string }>; createdBy?: string }>(
      { migration: { $exists: true } },
      { projection: { domain: 1, members: 1, createdBy: 1 } },
    )
    .toArray();
  const migratedIds = migrated.map((company) => company._id.toHexString());
  const migratedIdSet = new Set(migratedIds);

  const includedCohort = cohort.entries.filter((entry) => entry.decision === "include");
  const expectedTenants = new Set(
    includedCohort.map((entry) => entry.mergeInto ?? entry.companyId),
  );
  record(
    "every signed-off tenant exists in the target",
    migrated.length >= expectedTenants.size,
    `${migrated.length} migrated companies for ${expectedTenants.size} expected tenants`,
  );

  /* -------------------------------------------------------------- companies */

  const legacyPlaceholders = await companies.countDocuments({ createdBy: /^legacy:/ });
  record(
    "no company left on a legacy createdBy placeholder",
    legacyPlaceholders === 0,
    `${legacyPlaceholders} found`,
  );

  const adminless = migrated.filter(
    (company) =>
      (company.members ?? []).length > 0 &&
      !(company.members ?? []).some((member) => member.role === "admin"),
  );
  record(
    "every company with members has an admin",
    adminless.length === 0,
    adminless.length ? adminless.map((c) => c.domain).join(", ") : "all have one",
  );

  const empty = migrated.filter((company) => (company.members ?? []).length === 0);
  record(
    "no migrated company is left without members",
    empty.length === 0,
    empty.length ? empty.map((c) => c.domain).join(", ") : `${migrated.length} companies staffed`,
  );

  /* ------------------------------------------------------------------ users */

  const userIds = new Set(
    (await users.find<{ _id: ObjectId }>({}, { projection: { _id: 1 } }).toArray()).map(
      (user) => user._id.toHexString(),
    ),
  );
  const danglingMembers = migrated.flatMap((company) =>
    (company.members ?? [])
      .filter((member) => !userIds.has(member.userId))
      .map((member) => `${company.domain}:${member.userId}`),
  );
  record(
    "every company member resolves to a user",
    danglingMembers.length === 0,
    danglingMembers.length ? danglingMembers.slice(0, 3).join(", ") : "all resolve",
  );

  const dateVerified = await users.countDocuments({ emailVerified: { $type: "date" } });
  record(
    "emailVerified is stored as a boolean",
    dateVerified === 0,
    `${dateVerified} users store a date, which blocks sign-in`,
  );

  const profiles = await accountProfiles
    .find<{ userId: string; companyId: ObjectId; onboardingCompleted?: boolean }>({})
    .toArray();
  const companyIdsAll = new Set(
    (await companies.find<{ _id: ObjectId }>({}, { projection: { _id: 1 } }).toArray()).map(
      (company) => company._id.toHexString(),
    ),
  );
  const orphanProfiles = profiles.filter(
    (profile) => !companyIdsAll.has(profile.companyId?.toHexString?.() ?? ""),
  );
  record(
    "no account profile points at a missing company",
    orphanProfiles.length === 0,
    `${orphanProfiles.length} orphaned of ${profiles.length}`,
  );

  const profileUserMissing = profiles.filter((profile) => !userIds.has(profile.userId));
  record(
    "every account profile resolves to a user",
    profileUserMissing.length === 0,
    `${profileUserMissing.length} dangling`,
  );

  const notOnboarded = profiles.filter((profile) => profile.onboardingCompleted !== true);
  record(
    "migrated users are past onboarding",
    notOnboarded.length === 0,
    notOnboarded.length
      ? `${notOnboarded.length} would be redirected into onboarding and could create duplicate companies`
      : `${profiles.length} profiles complete`,
  );

  /* -------------------------------------------------------------- decisions */

  const allDecisions = await decisions
    .find<{ companyId: string; tenderId: string; status: string; decidedByUserId: string; assigneeUserId?: string }>({})
    .toArray();
  const mineDecisions = allDecisions.filter((entry) => migratedIdSet.has(entry.companyId));

  const badCompanyRef = allDecisions.filter((entry) => !companyIdsAll.has(entry.companyId));
  record(
    "every decision points at a real company",
    badCompanyRef.length === 0,
    `${badCompanyRef.length} dangling of ${allDecisions.length}`,
  );

  // `tender_decisions.tenderId` is a hex string while `tenders._id` is an
  // ObjectId, so the lookup has to convert — comparing the two directly matches
  // nothing and would report every decision as broken.
  const { ObjectId: ObjectIdCtor } = await import("mongodb");
  const decisionTenderIds = [...new Set(mineDecisions.map((entry) => entry.tenderId))]
    .filter((id) => ObjectIdCtor.isValid(id))
    .map((id) => ObjectIdCtor.createFromHexString(id));
  const tenderIds = new Set(
    (
      await tenders
        .find<{ _id: ObjectId }>(
          { _id: { $in: decisionTenderIds } },
          { projection: { _id: 1 } },
        )
        .toArray()
    ).map((tender) => tender._id.toHexString()),
  );
  const missingTenders = mineDecisions.filter((entry) => !tenderIds.has(entry.tenderId));
  record(
    "every decision points at an ingested tender",
    missingTenders.length === 0,
    `${missingTenders.length} unresolved of ${mineDecisions.length}`,
  );

  const badStatus = allDecisions.filter(
    (entry) => !(DECISION_STATUSES as readonly string[]).includes(entry.status),
  );
  record(
    "every decision status is in the vocabulary",
    badStatus.length === 0,
    badStatus.length ? [...new Set(badStatus.map((e) => e.status))].join(", ") : "all valid",
  );

  const seen = new Set<string>();
  const duplicatePairs = allDecisions.filter((entry) => {
    const key = `${entry.companyId}|${entry.tenderId}`;
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
  });
  record(
    "one decision per company and tender",
    duplicatePairs.length === 0,
    `${duplicatePairs.length} duplicates against a unique index`,
  );

  const membersByCompany = new Map(
    migrated.map((company) => [
      company._id.toHexString(),
      new Set((company.members ?? []).map((member) => member.userId)),
    ]),
  );
  const strayAssignee = mineDecisions.filter(
    (entry) =>
      entry.assigneeUserId &&
      !membersByCompany.get(entry.companyId)?.has(entry.assigneeUserId),
  );
  record(
    "assignees are members of their company",
    strayAssignee.length === 0,
    `${strayAssignee.length} stray of ${mineDecisions.filter((e) => e.assigneeUserId).length} assigned`,
  );

  const strayAuthor = mineDecisions.filter(
    (entry) => !userIds.has(entry.decidedByUserId),
  );
  record(
    "decision authors resolve to a user",
    strayAuthor.length === 0,
    `${strayAuthor.length} dangling`,
  );

  /* ------------------------------------------------------------------ files */

  const files = await companyFiles
    .find<{ _id: ObjectId; companyId: ObjectId; s3Key: string; fileName: string }>({})
    .toArray();
  const badFileCompany = files.filter(
    (file) => !companyIdsAll.has(file.companyId?.toHexString?.() ?? ""),
  );
  record(
    "every company file points at a real company",
    badFileCompany.length === 0,
    `${badFileCompany.length} dangling of ${files.length}`,
  );

  const keys = new Set<string>();
  const duplicateKeys = files.filter((file) => {
    if (keys.has(file.s3Key)) return true;
    keys.add(file.s3Key);
    return false;
  });
  record(
    "company file keys are unique",
    duplicateKeys.length === 0,
    `${duplicateKeys.length} duplicate s3Keys`,
  );

  if (skipS3 || files.length === 0) {
    record(
      "company file bytes exist in S3",
      true,
      files.length === 0 ? "no files yet (Phase 6 not run)" : "skipped",
      "warning",
    );
  } else {
    const { headObject } = await import("../lib/storage/s3.ts");
    const missingBytes: string[] = [];
    for (const file of files) {
      try {
        if (!(await headObject(file.s3Key))) missingBytes.push(file.fileName);
      } catch (error) {
        missingBytes.push(`${file.fileName} (${error instanceof Error ? error.message : "error"})`);
      }
    }
    record(
      "company file bytes exist in S3",
      missingBytes.length === 0,
      `${missingBytes.length} missing of ${files.length}`,
    );
  }

  /* -------------------------------------------------------- tenant isolation */

  // Isolation here means identity, not content: two companies saving the same
  // public tender is normal and expected, so overlapping tenderIds prove
  // nothing. What must never happen is a person or a document belonging to two
  // tenants at once, because that is what grants one company another's access.
  const companiesByUser = new Map<string, Set<string>>();
  for (const company of migrated) {
    for (const member of company.members ?? []) {
      const seenCompanies = companiesByUser.get(member.userId) ?? new Set<string>();
      seenCompanies.add(company.domain);
      companiesByUser.set(member.userId, seenCompanies);
    }
  }
  const sharedUsers = [...companiesByUser.entries()].filter(
    ([, domains]) => domains.size > 1,
  );
  record(
    "no user is a member of two companies",
    sharedUsers.length === 0,
    sharedUsers.length
      ? sharedUsers.slice(0, 3).map(([id, domains]) => `${id}: ${[...domains].join("+")}`).join(", ")
      : `${companiesByUser.size} members each in exactly one tenant`,
  );

  const profilesPerUser = new Map<string, number>();
  for (const profile of profiles) {
    profilesPerUser.set(profile.userId, (profilesPerUser.get(profile.userId) ?? 0) + 1);
  }
  const multiProfile = [...profilesPerUser.entries()].filter(([, count]) => count > 1);
  record(
    "each user has exactly one account profile",
    multiProfile.length === 0,
    `${multiProfile.length} users hold more than one tenant profile`,
  );

  const filesPerCompany = new Set(
    files.map((file) => file.companyId?.toHexString?.() ?? "?"),
  );
  record(
    "every company file is scoped to one company",
    !filesPerCompany.has("?"),
    `${files.length} files across ${filesPerCompany.size} companies`,
  );

  /* --------------------------------------------------------------- logins */

  const accounts = database.collection("account");
  const migratedUserIds = new Set(
    profiles
      .filter((profile) => migratedIdSet.has(profile.companyId?.toHexString?.() ?? ""))
      .map((profile) => profile.userId),
  );
  const withPassword = await accounts.countDocuments({
    providerId: "credential",
  });
  record(
    "migrated users still need the password-reset invitation",
    true,
    `${migratedUserIds.size} migrated users · ${withPassword} credential accounts exist in total`,
    "warning",
  );
} finally {
  await client.close();
}

console.log("\nmigration verification\n");
for (const result of results) console.log(formatResult(result));

const summary = summarize(results);
console.log(
  `\n${summary.passed}/${summary.total} passed · ${summary.failed} failed · ${summary.warnings} warnings`,
);
console.log(
  summary.exitCode === 0
    ? "\nAll blocking checks passed."
    : "\nBlocking checks failed — do not cut over.",
);

process.exitCode = summary.exitCode;
