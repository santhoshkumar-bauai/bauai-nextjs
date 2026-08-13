/**
 * Phase 3 of the Supabase → MongoDB migration: create the tenant companies.
 *
 * Reads the signed-off cohort from Phase 1, folds the agreed duplicates into a
 * single row each, maps the legacy columns onto `models/company.ts`, and upserts
 * on `domain` (the unique key). Idempotent: re-running updates the same
 * documents rather than creating new ones.
 *
 * Membership is deliberately NOT written here. `members[]` and `createdBy` need
 * target user ids, which only exist after Phase 4 — that phase backfills them.
 *
 * Refuses to run unless the cohort is signed off, and refuses to touch a
 * company that already has members (a live tenant is not migration payload).
 *
 * `--adopt` claims companies that this migration created before provenance
 * stamping existed: an existing company is adopted only when nobody has signed
 * in, set a password, or created anything in it. Needed once, to recover from a
 * pre-stamp run; harmless afterwards.
 *
 *   npm run migrate:companies -- [--dry-run] [--limit 5] [--trial-days 30] [--adopt]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient, ObjectId } = await import("mongodb");
const { fetchAll } = await import("../lib/migration/source.ts");
const { inspectTenantActivity } = await import("../lib/migration/tenant-activity.ts");
const { mergeSourceRows, resolveWebsiteFromRows, toCompanyDocument } = await import(
  "../lib/migration/companies.ts"
);

type SourceCompanyRow = import("../lib/migration/companies.ts").SourceCompanyRow;
type CohortReport = import("../lib/migration/cohort.ts").CohortReport;

function flag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? null) : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dryRun = has("dry-run");
const adopt = has("adopt");
const limit = Number.parseInt(flag("limit") ?? "0", 10) || 0;
const trialDays = Number.parseInt(flag("trial-days") ?? "30", 10) || 30;

const MIGRATION_DIR = path.join(process.cwd(), "docs", "migration-docs");
const REPORT_DIR = path.join(MIGRATION_DIR, "reports");
const COHORT_PATH = path.join(REPORT_DIR, "cohort.json");

const cohort = JSON.parse(await readFile(COHORT_PATH, "utf8")) as CohortReport;
if (!cohort.signedOffBy) {
  throw new Error(
    `cohort at ${COHORT_PATH} is not signed off — set signedOffBy in ` +
      `docs/migration-docs/cohort-overrides.json and re-run migrate:cohort first.`,
  );
}

const included = cohort.entries.filter((entry) => entry.decision === "include");
console.log(
  `cohort signed off by ${cohort.signedOffBy}: ${included.length} companies` +
    `${dryRun ? " [dry run: nothing will be written]" : ""}`,
);

/**
 * Groups the cohort into one target company per tenant: a merge survivor plus
 * everyone folded into it. Order matters — the survivor is first so its values
 * win when `mergeSourceRows` picks scalars.
 */
const groups = new Map<string, { name: string; legacyIds: string[] }>();
for (const entry of included) {
  const survivorId = entry.mergeInto ?? entry.companyId;
  const proposal = cohort.mergeProposals.find(
    (item) => item.survivorId === survivorId,
  );
  const group = groups.get(survivorId) ?? {
    name: proposal?.preferredName || entry.cleanedName,
    legacyIds: [],
  };
  // Survivor first, absorbed after.
  if (entry.companyId === survivorId) group.legacyIds.unshift(entry.companyId);
  else group.legacyIds.push(entry.companyId);
  groups.set(survivorId, group);
}

const targets = [...groups.entries()].slice(0, limit || undefined);
console.log(
  `${included.length} cohort rows fold into ${groups.size} companies` +
    `${limit ? `, processing ${targets.length}` : ""}`,
);

const allLegacyIds = targets.flatMap(([, group]) => group.legacyIds);
const rows = await fetchAll<SourceCompanyRow>(
  `companies?select=*&id=in.(${allLegacyIds.join(",")})`,
);
const rowById = new Map(rows.map((row) => [row.id, row]));
console.log(`fetched ${rows.length} legacy company rows`);

const now = new Date();
const trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);

interface Prepared {
  survivorId: string;
  legacyIds: string[];
  domain: string;
  name: string;
  document: ReturnType<typeof toCompanyDocument>["document"];
  issues: string[];
}

const prepared: Prepared[] = [];
const skipped: Array<{ survivorId: string; name: string; issues: string[] }> = [];

for (const [survivorId, group] of targets) {
  const sourceRows = group.legacyIds
    .map((id) => rowById.get(id))
    .filter((row): row is SourceCompanyRow => row !== undefined);

  if (sourceRows.length === 0) {
    skipped.push({ survivorId, name: group.name, issues: ["legacy row not found"] });
    continue;
  }

  const merged = mergeSourceRows(sourceRows);
  // Voted across every address column of every merged row, because individual
  // columns contain other companies' domains.
  const resolution = resolveWebsiteFromRows(sourceRows);
  const result = toCompanyDocument({
    row: merged,
    name: group.name,
    // Rewritten by Phase 4 once the target user exists; the legacy id keeps the
    // trail readable until then.
    createdBy: `legacy:${survivorId}`,
    trialStartsAt: now,
    trialEndsAt,
    site: resolution.site,
  });

  if (!result.document) {
    skipped.push({ survivorId, name: group.name, issues: result.issues });
    continue;
  }

  const issues = [...result.issues];
  if (resolution.disagreement) {
    issues.push(
      `address columns disagree, chose ${resolution.site?.domain} — ` +
        `rejected ${resolution.candidates
          .slice(1)
          .map((item) => `${item.domain} (${item.votes})`)
          .join(", ")}`,
    );
  }

  prepared.push({
    survivorId,
    legacyIds: group.legacyIds,
    domain: result.document.domain,
    name: result.document.name,
    document: result.document,
    issues,
  });
}

// Two different tenants normalising onto one domain would collide on the unique
// index; catching it here beats a half-finished run.
const byDomain = new Map<string, Prepared[]>();
for (const item of prepared) {
  byDomain.set(item.domain, [...(byDomain.get(item.domain) ?? []), item]);
}
const collisions = [...byDomain.entries()].filter(([, items]) => items.length > 1);
for (const [domain, items] of collisions) {
  console.error(
    `  COLLISION  ${domain} claimed by ${items.map((item) => item.name).join(" + ")}`,
  );
}
if (collisions.length > 0) {
  throw new Error(
    `${collisions.length} domain collisions — add a merge for these in ` +
      `cohort-overrides.json, or give one of them a distinct website.`,
  );
}

for (const item of prepared) {
  const merged = item.legacyIds.length > 1 ? ` (merged ${item.legacyIds.length} rows)` : "";
  console.log(`  ${item.domain.padEnd(28)} ${item.name.slice(0, 38)}${merged}`);
  for (const issue of item.issues) console.log(`      · ${issue}`);
}

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");
const client = new MongoClient(uri);

const written: string[] = [];
const protectedLive: string[] = [];
/** Pre-provenance companies claimed by `--adopt`. */
const adopted: string[] = [];

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const companies = database.collection("companies");

  // The model declares this; a standalone script run must not leave it missing.
  // No explicit name: Mongoose already created it as `domain_1`, and passing a
  // different name is an IndexOptionsConflict rather than a no-op. A dry run
  // creates nothing at all.
  if (!dryRun) await companies.createIndex({ domain: 1 }, { unique: true });

  for (const item of prepared) {
    const existing = await companies.findOne<{
      _id: InstanceType<typeof ObjectId>;
      members?: Array<{ userId: string }>;
      migration?: unknown;
    }>({ domain: item.domain }, { projection: { members: 1, migration: 1 } });

    // A company with members that this migration did not create is a live
    // tenant; overwriting its profile with legacy data would be destructive.
    // The provenance stamp is what separates those from our own earlier runs —
    // without it, Phase 4 filling `members` would block every later re-run.
    const unstamped =
      existing &&
      Array.isArray(existing.members) &&
      existing.members.length > 0 &&
      !existing.migration;

    if (unstamped) {
      // Without a stamp the only way to tell "ours, written before stamping"
      // from "a real customer" is behaviour: has anyone actually used it?
      const activity = adopt
        ? await inspectTenantActivity(database, {
            companyId: existing._id,
            memberUserIds: (existing.members ?? []).map((member) => member.userId),
            toObjectId: (hex) => ObjectId.createFromHexString(hex),
          })
        : { inUse: true, companyEvidence: [], liveMembers: new Map<string, string>() };

      if (activity.inUse) {
        protectedLive.push(item.domain);
        continue;
      }
      adopted.push(item.domain);
    }

    if (dryRun) continue;

    const { members, membershipRequests, ...mutable } = item.document!;
    await companies.updateOne(
      { domain: item.domain },
      {
        $set: {
          ...mutable,
          updatedAt: new Date(),
          // Provenance: proves this tenant came from the migration, which is
          // what lets later runs tell it apart from a real customer's company.
          migration: {
            legacyIds: item.legacyIds,
            signedOffBy: cohort.signedOffBy,
            ranAt: now,
          },
        },
        $setOnInsert: {
          createdAt: new Date(),
          members,
          membershipRequests,
          __v: 0,
        },
      },
      { upsert: true },
    );
    written.push(item.domain);
  }
} finally {
  await client.close();
}

for (const domain of adopted) {
  console.log(`  ADOPTED  ${domain} — unused, claiming it as migration-created`);
}
for (const domain of protectedLive) {
  console.warn(
    `  SKIPPED  ${domain} is in use — refusing to overwrite` +
      `${adopt ? "" : " (pass --adopt if this migration created it)"}`,
  );
}

const report = {
  phase: "03-companies",
  ranAt: new Date().toISOString(),
  dryRun,
  signedOffBy: cohort.signedOffBy,
  totals: {
    cohortRows: included.length,
    targetCompanies: groups.size,
    prepared: prepared.length,
    written: written.length,
    skipped: skipped.length,
    protectedLive: protectedLive.length,
    adopted: adopted.length,
  },
  adopted,
  companies: prepared.map((item) => ({
    domain: item.domain,
    name: item.name,
    legacyIds: item.legacyIds,
    issues: item.issues,
    services: item.document!.services.length,
    cpvCodes: item.document!.cpvCodes.length,
    businessDomain: item.document!.businessDomain,
  })),
  skipped,
  protectedLive,
};

console.log(
  `\nprepared ${prepared.length} · written ${written.length} · ` +
    `skipped ${skipped.length} · protected ${protectedLive.length}`,
);

if (dryRun) {
  console.log("[dry run] no documents were written");
} else {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-03-companies.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`wrote ${reportPath}`);
  console.log("\nNext: Phase 4 creates the users and backfills members/createdBy.");
}
