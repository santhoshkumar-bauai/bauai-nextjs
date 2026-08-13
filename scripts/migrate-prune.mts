/**
 * Removes migrated tenants that are no longer in the signed-off cohort.
 *
 * Phases 3 and 4 only ever upsert, so excluding a company after it has been
 * migrated leaves the company, its users and their profiles behind. This script
 * is the other half of that: it reconciles what was written against what the
 * cohort now says should exist, and deletes the difference.
 *
 * It is deliberately timid. It will only touch a document that
 *   (a) is named in a phase report, so it cannot remove anything the migration
 *       did not create, and
 *   (b) shows no sign of use in the new system.
 *
 * A company with decisions, files, chats or workspace documents is left alone,
 * as is a user who has set a password or holds a session — those are people
 * using the product, not migration leftovers.
 *
 *   npm run migrate:prune -- [--dry-run] [--yes]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient, ObjectId } = await import("mongodb");
const { inspectTenantActivity } = await import("../lib/migration/tenant-activity.ts");

type CohortReport = import("../lib/migration/cohort.ts").CohortReport;

const has = (name: string) => process.argv.includes(`--${name}`);
const dryRun = has("dry-run");

const REPORT_DIR = path.join(process.cwd(), "docs", "migration-docs", "reports");

const cohort = JSON.parse(
  await readFile(path.join(REPORT_DIR, "cohort.json"), "utf8"),
) as CohortReport;
if (!cohort.signedOffBy) {
  throw new Error("cohort is not signed off — refusing to delete anything");
}

interface PhaseThreeReport {
  companies: Array<{ domain: string; name: string; legacyIds: string[] }>;
}
const phaseThree = JSON.parse(
  await readFile(path.join(REPORT_DIR, "phase-03-companies.json"), "utf8"),
) as PhaseThreeReport;

// What the cohort says should exist now, by legacy id.
const includedLegacyIds = new Set(
  cohort.entries
    .filter((entry) => entry.decision === "include")
    .map((entry) => entry.companyId),
);

// A previously-migrated company is stale when none of the legacy rows it was
// built from are still included.
const stale = phaseThree.companies.filter(
  (company) => !company.legacyIds.some((id) => includedLegacyIds.has(id)),
);

console.log(
  `cohort signed off by ${cohort.signedOffBy}: ` +
    `${phaseThree.companies.length} migrated companies, ${stale.length} now excluded` +
    `${dryRun ? " [dry run: nothing will be deleted]" : ""}`,
);

if (stale.length === 0) {
  console.log("nothing to prune.");
  process.exit(0);
}

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");
const client = new MongoClient(uri);

interface Removal {
  domain: string;
  companyId: string;
  users: string[];
  keptUsers: Array<{ email: string; reason: string }>;
}

const removals: Removal[] = [];
const refused: Array<{ domain: string; reason: string }> = [];

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const companies = database.collection("companies");
  const users = database.collection("user");
  // Credential accounts and sessions are read through inspectTenantActivity,
  // so the two scripts cannot drift on what counts as a real user.
  const accountProfiles = database.collection("accountprofiles");

  for (const target of stale) {
    const company = await companies.findOne<{
      _id: InstanceType<typeof ObjectId>;
      members?: Array<{ userId: string; email: string }>;
    }>({ domain: target.domain });

    if (!company) {
      console.log(`  ${target.domain}: already gone`);
      continue;
    }

    const memberIds = (company.members ?? []).map((member) => member.userId);

    // Same rule Phase 3 uses to decide whether it may adopt a company, so the
    // two can never disagree about what counts as a real tenant.
    const activity = await inspectTenantActivity(database, {
      companyId: company._id,
      memberUserIds: memberIds,
      toObjectId: (hex) => ObjectId.createFromHexString(hex),
    });

    if (activity.companyEvidence.length > 0) {
      refused.push({ domain: target.domain, reason: activity.companyEvidence.join(", ") });
      continue;
    }

    const removableUsers: string[] = [];
    const keptUsers: Array<{ email: string; reason: string }> = [];

    for (const userId of memberIds) {
      const objectId = ObjectId.createFromHexString(userId);
      const user = await users.findOne<{ email: string }>({ _id: objectId });
      if (!user) continue;

      // Someone who set a password or holds a session is a real person; so is
      // anyone who also belongs to another tenant.
      const liveReason = activity.liveMembers.get(userId);
      const otherProfiles = await accountProfiles.countDocuments({
        userId,
        companyId: { $ne: company._id },
      });

      if (otherProfiles > 0) {
        keptUsers.push({ email: user.email, reason: "belongs to another company" });
      } else if (liveReason) {
        keptUsers.push({ email: user.email, reason: liveReason });
      } else {
        removableUsers.push(userId);
      }
    }

    if (!dryRun) {
      await accountProfiles.deleteMany({
        userId: { $in: removableUsers },
        companyId: company._id,
      });
      await users.deleteMany({
        _id: { $in: removableUsers.map((id) => ObjectId.createFromHexString(id)) },
      });
      await companies.deleteOne({ _id: company._id });
    }

    removals.push({
      domain: target.domain,
      companyId: company._id.toHexString(),
      users: removableUsers,
      keptUsers,
    });
  }
} finally {
  await client.close();
}

for (const removal of removals) {
  console.log(
    `  ${dryRun ? "would remove" : "removed"} ${removal.domain} ` +
      `(+${removal.users.length} users)`,
  );
  for (const kept of removal.keptUsers) {
    console.log(`      kept ${kept.email}: ${kept.reason}`);
  }
}
for (const entry of refused) {
  console.warn(`  REFUSED ${entry.domain}: in use — ${entry.reason}`);
}

console.log(
  `\n${dryRun ? "would remove" : "removed"} ${removals.length} companies and ` +
    `${removals.reduce((sum, item) => sum + item.users.length, 0)} users` +
    `${refused.length ? `, refused ${refused.length}` : ""}`,
);

if (!dryRun) {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-prune.json");
  await writeFile(
    reportPath,
    `${JSON.stringify(
      { phase: "prune", ranAt: new Date().toISOString(), removals, refused },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`wrote ${reportPath}`);
  console.log("\nNext: re-run migrate:companies and migrate:users to reconcile.");
}
