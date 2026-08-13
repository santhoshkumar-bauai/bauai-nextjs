/**
 * Phase 7 of the Supabase → MongoDB migration: the leftovers.
 *
 * Its main job is to make sure nothing is dropped *silently*. Three legacy
 * tables have no clean home in the new platform, and this records them so the
 * decision is on paper and the content is recoverable.
 *
 * SAVED SEARCH PROFILES — exported, not migrated by default.
 *   The two filter models barely overlap. The new one selects on CPV divisions,
 *   NUTS-1 regions, status, contract nature and a 0..1 relevance score; the
 *   legacy one selects on a city with a radius, a value range, a buyer name,
 *   negative keywords and a 0..100 match score. Of the cohort's 14 profiles only
 *   4 carry a keyword that maps to anything, while all 14 carry settings with no
 *   target field at all. A profile called "BERLIN 200" that quietly lost its
 *   city and its radius is worse than an absent one: it looks like it still
 *   works. `--include-filters` migrates the keyword-only remainder anyway.
 *
 * COMPANY DOMAIN → CPV DIVISIONS — checked against the shipped onboarding
 *   catalog, which already carries this mapping; migrating would duplicate it.
 *
 * FEEDBACK — exported. It is user-authored, has no target collection, and is
 *   worth keeping outside the database.
 *
 *   npm run migrate:misc -- [--dry-run] [--include-filters]
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { mkdir, readFile, writeFile } = await import("node:fs/promises");
const path = await import("node:path");
const { MongoClient } = await import("mongodb");
const { fetchAll, fetchAuthUsers } = await import("../lib/migration/source.ts");

/**
 * The empty baseline from `lib/tenders/filters.ts`, restated rather than
 * imported: that module resolves through the `@/lib` path alias, which Next and
 * vitest understand but Node's ESM loader does not. Only a keyword is carried
 * over, so the full normalizer would have nothing else to do.
 */
const EMPTY_TENDER_FILTERS = {
  statuses: [] as string[],
  contractNatures: [] as string[],
  sectors: [] as string[],
  regions: [] as string[],
};

type CohortReport = import("../lib/migration/cohort.ts").CohortReport;

const has = (name: string) => process.argv.includes(`--${name}`);
const dryRun = has("dry-run");
const includeFilters = has("include-filters");

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
const domainByLegacyCompany = new Map<string, string>();
for (const company of phaseThree.companies) {
  for (const legacyId of company.legacyIds) {
    domainByLegacyCompany.set(legacyId, company.domain);
  }
}
const legacyCompanyIds = [...domainByLegacyCompany.keys()];

console.log(`collecting leftovers${dryRun ? " [dry run]" : ""}`);

interface LegacyFilter {
  id: string;
  user_id: string | null;
  company_id: string | null;
  profile_name: string | null;
  filter_config: Record<string, unknown> | null;
  created_at: string | null;
}

const [filters, cpvDivisions, feedback, authUsers] = await Promise.all([
  fetchAll<LegacyFilter>(
    `saved_filter_profiles?select=id,user_id,company_id,profile_name,filter_config,created_at&company_id=in.(${legacyCompanyIds.join(",")})`,
  ),
  fetchAll<{ company_domain: string; cpv_division: string; note: string | null }>(
    "company_domain_cpv_divisions?select=company_domain,cpv_division,note",
  ),
  fetchAll<{ id: string; user_id: string | null; content: string | null; type: string | null; rating: number | null; created_at: string | null }>(
    "feedback?select=id,user_id,content,type,rating,created_at",
  ),
  fetchAuthUsers(),
]);

/** Settings a legacy profile carries that the new filter model cannot express. */
const UNMAPPABLE = [
  "city", "cityPlaceId", "cityCoordinates", "distance", "region",
  "regionCoordinates", "valueRange", "buyerName", "negativeKeywords",
  "previousProjects", "profileOverride", "serviceCategories", "aiRecommendation",
  "matchScore", "tenderType", "procedureType", "deadlineType", "state",
];

const isMeaningful = (value: unknown) => {
  if (value === null || value === undefined || value === "") return false;
  if (Array.isArray(value)) return value.length > 0 && !value.every((item) => item === 0);
  return true;
};

const filterAudit = filters.map((filter) => {
  const config = filter.filter_config ?? {};
  const keyword = String(config.serviceKeywords ?? "").trim();
  const lost = UNMAPPABLE.filter((key) => isMeaningful(config[key]));
  return {
    legacyId: filter.id,
    name: filter.profile_name,
    domain: filter.company_id ? domainByLegacyCompany.get(filter.company_id) : null,
    legacyUserId: filter.user_id,
    keyword: keyword || null,
    lostSettings: lost,
    legacyConfig: config,
  };
});

console.log(
  `  saved filters: ${filters.length} · ${filterAudit.filter((f) => f.keyword).length} carry a keyword · ` +
    `${filterAudit.filter((f) => f.lostSettings.length > 0).length} carry settings with no target field`,
);
console.log(`  cpv divisions: ${cpvDivisions.length} rows`);
console.log(`  feedback: ${feedback.length} rows`);

// The onboarding catalog ships this mapping already; migrating it would create
// a second, diverging copy.
const catalog = await import("../data/onboarding-catalog.ts");
const catalogDomains = new Set(catalog.companyDomains.map((option) => option.value));
const unknownDomains = [
  ...new Set(cpvDivisions.map((row) => row.company_domain).filter((d) => !catalogDomains.has(d))),
];
console.log(
  `  cpv divisions covering domains outside the shipped catalog: ${unknownDomains.length}` +
    `${unknownDomains.length ? ` (${unknownDomains.join(", ")})` : ""}`,
);

const migratedFilters: string[] = [];

if (includeFilters) {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not configured.");
  const client = new MongoClient(uri);
  const emailByLegacyUser = new Map(
    authUsers.flatMap((user) => (user.email ? [[user.id, user.email.toLowerCase()] as const] : [])),
  );

  try {
    await client.connect();
    const database = client.db(process.env.MONGODB_DB || "bauai");
    const users = database.collection("user");
    const savedFilters = database.collection("saved_tender_filters");

    for (const entry of filterAudit) {
      if (!entry.keyword || !entry.legacyUserId) continue;
      const email = emailByLegacyUser.get(entry.legacyUserId);
      const user = email
        ? await users.findOne<{ _id: { toHexString(): string } }>({ email })
        : null;
      if (!user) continue;

      const name = (entry.name?.trim() || entry.keyword).slice(0, 60);
      // Everything except the keyword is dropped, so the preset is built from
      // the empty baseline rather than a half-translated legacy object.
      const normalized = { ...EMPTY_TENDER_FILTERS, q: entry.keyword };

      if (!dryRun) {
        await savedFilters.updateOne(
          { userId: user._id.toHexString(), name },
          {
            $set: { filters: normalized },
            $setOnInsert: {
              userId: user._id.toHexString(),
              name,
              createdAt: entry.legacyConfig && filters.length ? new Date() : new Date(),
            },
          },
          { upsert: true },
        );
      }
      migratedFilters.push(`${name} (${entry.domain})`);
    }
  } finally {
    await client.close();
  }
  console.log(`  migrated ${migratedFilters.length} keyword-only presets`);
}

const report = {
  phase: "07-misc",
  ranAt: new Date().toISOString(),
  dryRun,
  signedOffBy: cohort.signedOffBy,
  savedFilters: {
    decision: includeFilters
      ? "keyword-only presets migrated; every other setting dropped"
      : "exported, not migrated — the legacy and target filter models do not overlap",
    total: filters.length,
    withKeyword: filterAudit.filter((entry) => entry.keyword).length,
    migrated: migratedFilters.length,
    profiles: filterAudit,
  },
  cpvDivisions: {
    decision: "not migrated — the shipped onboarding catalog already carries this mapping",
    total: cpvDivisions.length,
    domainsOutsideCatalog: unknownDomains,
    rows: cpvDivisions,
  },
  feedback: {
    decision: "exported only — user-authored, no target collection",
    total: feedback.length,
    rows: feedback,
  },
};

if (dryRun) {
  console.log("\n[dry run] no report written, nothing migrated");
} else {
  await mkdir(REPORT_DIR, { recursive: true });
  const reportPath = path.join(REPORT_DIR, "phase-07-misc.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\nwrote ${reportPath}`);
  console.log(
    includeFilters
      ? "saved searches migrated as keyword-only presets"
      : "saved searches were exported for manual recreation, not migrated",
  );
}
