/**
 * Phase 4 of the Supabase → MongoDB migration: the users and their membership.
 *
 * Creates a Better Auth `user` per migrating profile, an `accountprofiles` row,
 * fills `companies.members[]`, and replaces the `legacy:<uuid>` placeholder
 * Phase 3 left in `createdBy`.
 *
 * No password is migrated and no `account` row is written. Better Auth's
 * reset-password route creates the credential account itself when one is
 * missing, so a migrated user needs only the `user` row: they request a reset,
 * set a password, and the account appears. Fabricating a scrypt hash would add
 * risk and buy nothing.
 *
 * Safety: an existing user is never rewritten (identity fields are
 * `$setOnInsert` only), and a user already attached to a different company is
 * skipped rather than reassigned.
 *
 *   npm run migrate:users -- [--dry-run] [--locale de] [--limit 5]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient, ObjectId } = await import("mongodb");
const { fetchAll, fetchAuthUsers } = await import("../lib/migration/source.ts");
const {
  assignRoles,
  buildAccountProfile,
  buildMemberEntry,
  buildUserDocument,
  pickCreatedBy,
} = await import("../lib/migration/users.ts");

type SourceProfileRow = import("../lib/migration/users.ts").SourceProfileRow;
type MemberEntry = import("../lib/migration/users.ts").MemberEntry;
type CohortReport = import("../lib/migration/cohort.ts").CohortReport;

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const limit = Number.parseInt(flag("limit") ?? "0", 10) || 0;
const locale = (flag("locale") ?? "de") === "en" ? "en" : "de";

const MIGRATION_DIR = path.join(process.cwd(), "docs", "migration-docs");
const REPORT_DIR = path.join(MIGRATION_DIR, "reports");

const cohort = JSON.parse(
  await readFile(path.join(REPORT_DIR, "cohort.json"), "utf8"),
) as CohortReport;
if (!cohort.signedOffBy) {
  throw new Error("cohort is not signed off — see docs/migration-docs/cohort-overrides.json");
}

interface PhaseThreeReport {
  companies: Array<{ domain: string; name: string; legacyIds: string[] }>;
}
const phaseThree = JSON.parse(
  await readFile(path.join(REPORT_DIR, "phase-03-companies.json"), "utf8"),
) as PhaseThreeReport;

console.log(
  `cohort signed off by ${cohort.signedOffBy}; ${phaseThree.companies.length} companies from Phase 3` +
    `${dryRun ? " [dry run: nothing will be written]" : ""}`,
);

// Legacy company id → the domain that company became. Merged companies map
// several legacy ids onto one domain, which is exactly what we want here.
const domainByLegacyId = new Map<string, string>();
for (const company of phaseThree.companies) {
  for (const legacyId of company.legacyIds) {
    domainByLegacyId.set(legacyId, company.domain);
  }
}

const legacyCompanyIds = [...domainByLegacyId.keys()];
const [profiles, authUsers] = await Promise.all([
  fetchAll<SourceProfileRow>(
    `profiles?select=id,company_id,role,user_role,full_name,is_onboarding_completed,created_at&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAuthUsers(),
]);
const authUserById = new Map(authUsers.map((user) => [user.id, user]));
console.log(`fetched ${profiles.length} profiles and ${authUsers.length} auth users`);

// Group by target domain, not legacy company, so merged tenants share one roster.
const profilesByDomain = new Map<string, SourceProfileRow[]>();
for (const profile of profiles) {
  const domain = profile.company_id ? domainByLegacyId.get(profile.company_id) : undefined;
  if (!domain) continue;
  profilesByDomain.set(domain, [...(profilesByDomain.get(domain) ?? []), profile]);
}

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");
const client = new MongoClient(uri);
const now = new Date();

interface SkippedUser {
  email: string;
  domain: string;
  reason: string;
}

const createdUsers: string[] = [];
const reusedUsers: string[] = [];
const skippedUsers: SkippedUser[] = [];
const promoted: string[] = [];
/** Companies whose only possible admin is a test address — needs a human. */
const testAdmins: Array<{ email: string; domain: string }> = [];
const companySummaries: Array<{
  domain: string;
  members: number;
  admins: number;
  createdBy: string | null;
  unverified: number;
}> = [];

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const companies = database.collection("companies");
  const users = database.collection("user");
  const accountProfiles = database.collection("accountprofiles");

  const targets = [...profilesByDomain.entries()].slice(0, limit || undefined);

  for (const [domain, roster] of targets) {
    const company = await companies.findOne<{
      _id: InstanceType<typeof ObjectId>;
      name: string;
      members?: unknown[];
      migration?: unknown;
      trial?: { startsAt?: Date; endsAt?: Date };
      createdBy?: string;
    }>({ domain });

    if (!company) {
      for (const profile of roster) {
        skippedUsers.push({
          email: authUserById.get(profile.id)?.email ?? profile.id,
          domain,
          reason: "company not found in target — run Phase 3 first",
        });
      }
      continue;
    }

    // A tenant with a roster that this migration did not create must not have
    // it rewritten. The provenance stamp Phase 3 leaves is the discriminator:
    // testing `createdBy` instead would make this script block its own re-runs
    // the moment it filled `members`.
    const isLiveTenant =
      Array.isArray(company.members) &&
      company.members.length > 0 &&
      !company.migration;
    if (isLiveTenant) {
      for (const profile of roster) {
        skippedUsers.push({
          email: authUserById.get(profile.id)?.email ?? profile.id,
          domain,
          reason: "company already has a live roster — refusing to overwrite",
        });
      }
      continue;
    }

    // Role assignment needs the addresses so a test account is not handed the
    // company while a real colleague is available.
    const emailByProfileId = new Map(
      roster.flatMap((profile) => {
        const email = authUserById.get(profile.id)?.email;
        return email ? [[profile.id, email] as const] : [];
      }),
    );
    const roles = assignRoles(roster, emailByProfileId);
    const members: MemberEntry[] = [];
    let unverified = 0;

    for (const profile of roster) {
      const authUser = authUserById.get(profile.id);
      if (!authUser) {
        skippedUsers.push({ email: profile.id, domain, reason: "no auth user" });
        continue;
      }

      const userDocument = buildUserDocument({ profile, authUser, now });
      if (!userDocument) {
        skippedUsers.push({ email: profile.id, domain, reason: "no email address" });
        continue;
      }
      if (!userDocument.emailVerified) unverified += 1;

      const assignment = roles.get(profile.id) ?? { role: "member" as const, promoted: false };

      // An existing user is left exactly as it is: only insert writes identity.
      const existing = await users.findOne<{ _id: InstanceType<typeof ObjectId> }>({
        email: userDocument.email,
      });

      let userId: InstanceType<typeof ObjectId>;
      if (existing) {
        const existingProfile = await accountProfiles.findOne<{
          companyId?: InstanceType<typeof ObjectId>;
        }>({ userId: existing._id.toHexString() });

        if (
          existingProfile?.companyId &&
          !existingProfile.companyId.equals(company._id)
        ) {
          skippedUsers.push({
            email: userDocument.email,
            domain,
            reason: "user already belongs to a different company",
          });
          continue;
        }

        userId = existing._id;
        reusedUsers.push(userDocument.email);
      } else {
        userId = new ObjectId();
        if (!dryRun) {
          await users.insertOne({ _id: userId, ...userDocument });
        }
        createdUsers.push(userDocument.email);
      }

      if (assignment.promoted) promoted.push(`${userDocument.email} (${domain})`);
      if (assignment.promotedTestAccount) {
        testAdmins.push({ email: userDocument.email, domain });
      }

      const member = buildMemberEntry({
        userId: userId.toHexString(),
        email: userDocument.email,
        role: assignment.role,
        joinedAt: profile.created_at,
        now,
      });
      members.push(member);

      if (!dryRun) {
        const accountProfile = buildAccountProfile({
          userId: userId.toHexString(),
          email: userDocument.email,
          role: assignment.role,
          locale,
          trialStartsAt: company.trial?.startsAt ?? now,
          trialEndsAt: company.trial?.endsAt ?? now,
          now,
        });
        const { createdAt, ...mutable } = accountProfile;
        await accountProfiles.updateOne(
          { userId: accountProfile.userId },
          {
            $set: { ...mutable, companyId: company._id },
            $setOnInsert: { createdAt, __v: 0 },
          },
          { upsert: true },
        );
      }
    }

    const createdBy = pickCreatedBy(members);
    if (!dryRun && members.length > 0) {
      await companies.updateOne(
        { _id: company._id },
        {
          $set: {
            members,
            ...(createdBy ? { createdBy } : {}),
            updatedAt: new Date(),
          },
        },
      );
    }

    companySummaries.push({
      domain,
      members: members.length,
      admins: members.filter((member) => member.role === "admin").length,
      createdBy,
      unverified,
    });
  }
} finally {
  await client.close();
}

for (const summary of companySummaries) {
  console.log(
    `  ${summary.domain.padEnd(30)} members=${String(summary.members).padStart(2)} ` +
      `admins=${summary.admins}` +
      `${summary.unverified ? `  (${summary.unverified} unverified email)` : ""}`,
  );
}
if (promoted.length > 0) {
  console.log(`\npromoted to admin (no admin title in the legacy data):`);
  for (const entry of promoted) console.log(`  · ${entry}`);
}
if (testAdmins.length > 0) {
  console.warn(
    `\nREVIEW — these companies have no genuine account, so a test address ` +
      `became their admin:`,
  );
  for (const entry of testAdmins) {
    console.warn(`  · ${entry.email} now administers ${entry.domain}`);
  }
  console.warn(
    `  These tenants may be internal signups against a real company's website ` +
      `rather than customers. Consider excluding them in cohort-overrides.json.`,
  );
}
for (const skipped of skippedUsers) {
  console.warn(`  SKIPPED ${skipped.email} (${skipped.domain}): ${skipped.reason}`);
}

const totalUnverified = companySummaries.reduce(
  (sum, summary) => sum + summary.unverified,
  0,
);

console.log(
  `\ncreated ${createdUsers.length} users · reused ${reusedUsers.length} · ` +
    `skipped ${skippedUsers.length} · promoted ${promoted.length} admins · ` +
    `${totalUnverified} unverified emails`,
);

const report = {
  phase: "04-users",
  ranAt: new Date().toISOString(),
  dryRun,
  locale,
  signedOffBy: cohort.signedOffBy,
  totals: {
    profiles: profiles.length,
    created: createdUsers.length,
    reused: reusedUsers.length,
    skipped: skippedUsers.length,
    promotedAdmins: promoted.length,
    unverifiedEmails: totalUnverified,
    testAccountAdmins: testAdmins.length,
  },
  companies: companySummaries,
  promoted,
  testAccountAdmins: testAdmins,
  skipped: skippedUsers,
  createdUsers,
  note:
    "No credential accounts were created. Better Auth's reset-password route " +
    "creates one on first use, so every migrated user must set a password via " +
    "the reset flow before they can sign in.",
};

if (dryRun) {
  console.log("\n[dry run] nothing was written");
} else {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-04-users.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${reportPath}`);
  console.log(
    "\nNext: send the password-reset invitations, then Phase 5 (tender decisions).",
  );
}
