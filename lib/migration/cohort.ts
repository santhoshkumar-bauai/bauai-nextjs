/**
 * Decides which legacy tenants migrate, and proposes the cleanups they need.
 *
 * The legacy database holds 268 companies, but most are not customers: 200 have
 * no activity at all, and one fallback company ("Test Company") absorbed 110
 * users whose signup never picked a real tenant. Migrating everything would
 * import that junk into a clean database, so this module scores each company on
 * observable activity and sorts it into include / review / exclude.
 *
 * Everything here is pure — no database, no network — so the rules are unit
 * tested in `cohort.test.ts` and a human can re-run them on a fixture. The
 * script wrapper (`scripts/migrate-01-cohort.mts`) does all the I/O.
 *
 * The output is advisory: `reviewNeeded` and `mergeProposals` exist because
 * some judgements cannot be made safely by a regex (see `looksLikeDomainName`).
 */

export interface SourceCompany {
  id: string;
  name: string | null;
  domain: string | null;
  company_domain: string | null;
  website: string | null;
  company_website: string | null;
  created_at: string | null;
}

export interface SourceProfile {
  id: string;
  company_id: string | null;
  is_onboarding_completed: boolean | null;
}

export interface ActivityCounts {
  savedTenders: number;
  dislikedTenders: number;
  workspaceTenders: number;
  chatSessions: number;
  documents: number;
  savedFilters: number;
  extractedDocuments: number;
}

export interface MemberCounts {
  members: number;
  signedIn: number;
  recentlyActive: number;
  onboarded: number;
}

export type CohortDecision = "include" | "review" | "exclude";

export interface CohortEntry {
  companyId: string;
  name: string;
  cleanedName: string;
  domain: string | null;
  createdAt: string | null;
  decision: CohortDecision;
  reason: string;
  activityTotal: number;
  activity: ActivityCounts;
  membership: MemberCounts;
  /** Set when this company is proposed to fold into another. */
  mergeInto?: string;
  /** Name of the person whose override decided this entry, if any. */
  overriddenBy?: string;
}

export interface MergeProposal {
  /** Company that survives — the one with the most activity, so the richest row. */
  survivorId: string;
  survivorName: string;
  /**
   * The name the merged company should carry, which is not always the
   * survivor's: the busiest row is often the one signup named after an email
   * domain ("hns-bau-gmbh.de"), while its quieter duplicate has the real name
   * ("HNS Bau GmbH").
   */
  preferredName: string;
  /** Companies proposed to fold into the survivor. */
  absorbedIds: string[];
  absorbedNames: string[];
  matchKey: string;
}

/**
 * A human decision that outranks the scoring rules. Keyed by company id or by
 * exact cleaned name in `cohort-overrides.json`, which is checked in and
 * hand-maintained — the generated report is overwritten on every run, so
 * decisions cannot live there.
 */
export interface CohortOverride {
  decision: "include" | "exclude";
  reason: string;
  by: string;
}

export type CohortOverrides = Record<string, CohortOverride>;

export interface CohortReport {
  generatedAt: string;
  totals: {
    sourceCompanies: number;
    sourceProfiles: number;
    include: number;
    review: number;
    exclude: number;
    usersInCohort: number;
  };
  /** Set by a human before the migration runs. Nothing downstream runs while false. */
  signedOffBy: string | null;
  entries: CohortEntry[];
  mergeProposals: MergeProposal[];
  /** Conflicts worth a human's attention — never silently resolved. */
  warnings: string[];
}

/**
 * Signup created a company per user when none matched, so a name that is just
 * the user's email domain usually means "nobody filled the form in". Some of
 * those are still real firms (hns-bau-gmbh.de, hansabauteam.de), which is why
 * these go to human review rather than straight to exclude.
 */
const DOMAIN_NAME = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

/** Consumer mail hosts — a company named after one is a solo/personal signup. */
const FREEMAIL = new Set([
  "gmail.com", "yahoo.com", "yahoo.de", "hotmail.com", "hotmail.de",
  "outlook.com", "outlook.de", "icloud.com", "aol.com", "gmx.de", "gmx.net",
  "web.de", "t-online.de", "proton.me", "me.com", "mail.com", "email.com",
  "live.com", "msn.com", "tuta.com", "comcast.net", "verizon.net",
  "sbcglobal.net", "bellsouth.net", "talktalk.net", "rogers.com", "mac.com",
]);

/**
 * Test signups embed the marker mid-word ("architekttest.de", "baufirmatest.de",
 * "demooo23.com"), so most of these match as substrings. The exceptions are
 * guarded: `trial` would swallow "Industrial", and `demo` would swallow the very
 * plausible German "Demontage"/"Demolierung". Anything excluded still appears in
 * the report with its reason, so a false positive is caught at sign-off.
 */
const TEST_NAME =
  /test|dummy|fake|sample|example|pricing|anirban|tushar|kittytester|demo(?!nt|li)|(^|[^a-z])(trial|qa)(?![a-z])/i;

/** A signup fallback bucket, not a tenant: far more members than any real firm. */
const FALLBACK_BUCKET_MEMBERS = 50;

const LEGAL_FORMS = [
  "gmbh", "mbh", "ag", "kg", "ohg", "gbr", "ug", "se", "partgmbb", "partg",
  "eg", "ev", "ltd", "llc", "inc", "co", "kgaa", "gruppe", "group", "holding",
];

/** Long enough to strip from the end of a run-together domain name safely. */
const STRIPPABLE_NAME_SUFFIXES = [
  "partgmbb", "holding", "gruppe", "group", "gmbh", "kgaa",
];

/** Boilerplate that leaked in from scraped Impressum pages. */
const SCRAPE_BOILERPLATE = /\b(impressum|datenschutz|startseite|home|kontakt)\b/gi;

const HTML_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

/**
 * Company names were partly scraped from website titles, so they arrive with
 * numeric and named HTML entities ("Impressum &#038; Datenschutz &#8211; …").
 */
export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name) => {
      const decoded = HTML_ENTITIES[String(name).toLowerCase()];
      return decoded ?? match;
    });
}

/** Decodes entities, drops scraped boilerplate, and collapses whitespace. */
export function cleanCompanyName(raw: string | null): string {
  if (!raw) return "";
  return decodeHtmlEntities(raw)
    .replace(SCRAPE_BOILERPLATE, " ")
    // Separators and conjunctions left behind once the boilerplate is gone:
    // "Impressum & Datenschutz – Hansa Bau" strips down to "& – Hansa Bau".
    .replace(/^[\s\p{Pd}|,:•·&]+|[\s\p{Pd}|,:•·&]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function looksLikeDomainName(name: string): boolean {
  return DOMAIN_NAME.test(name.trim());
}

export function looksLikeFreemailName(name: string): boolean {
  return FREEMAIL.has(name.trim().toLowerCase());
}

export function looksLikeTestName(name: string): boolean {
  return TEST_NAME.test(name);
}

/**
 * A comparison key that survives casing, legal form, punctuation, and the
 * domain-vs-display-name split — so "WIRL INGENIEURE GMBH", "Wirl Ingenieure
 * GmbH" and "wirl-ingenieure.de" all collapse to "wirlingenieure".
 */
export function mergeKey(rawName: string): string {
  const cleaned = cleanCompanyName(rawName).toLowerCase();
  const withoutTld = looksLikeDomainName(cleaned)
    ? cleaned.replace(/\.[a-z]{2,}$/i, "")
    : cleaned;

  const words = withoutTld
    .split(/[^a-z0-9]+/i)
    .filter((word) => word.length > 0 && !LEGAL_FORMS.includes(word));

  const key = words.join("");

  // A domain name concatenates its words ("lavettegruppe.com"), so the legal
  // form survives the word filter above and would not match the same firm
  // written out ("Lavette GmbH"). Only long, unambiguous suffixes are stripped:
  // trimming a short one would maul real names ("Montag" → "mont").
  for (const suffix of STRIPPABLE_NAME_SUFFIXES) {
    if (key.endsWith(suffix) && key.length > suffix.length + 2) {
      return key.slice(0, -suffix.length);
    }
  }

  return key;
}

export function activityTotal(activity: ActivityCounts): number {
  // Deliberately excludes extractedDocuments: a single tender analysis can
  // create hundreds of rows, which would drown out every other signal.
  return (
    activity.savedTenders +
    activity.dislikedTenders +
    activity.workspaceTenders +
    activity.chatSessions +
    activity.documents +
    activity.savedFilters
  );
}

export interface CohortInput {
  companies: SourceCompany[];
  profiles: SourceProfile[];
  activityByCompany: Map<string, ActivityCounts>;
  membershipByCompany: Map<string, MemberCounts>;
  /** Human decisions, keyed by company id or exact cleaned name. */
  overrides?: CohortOverrides;
}

const EMPTY_ACTIVITY: ActivityCounts = {
  savedTenders: 0, dislikedTenders: 0, workspaceTenders: 0,
  chatSessions: 0, documents: 0, savedFilters: 0, extractedDocuments: 0,
};

const EMPTY_MEMBERSHIP: MemberCounts = {
  members: 0, signedIn: 0, recentlyActive: 0, onboarded: 0,
};

/**
 * Applies the agreed "strict" rule: a company migrates when it shows real
 * activity and is recognisably a real firm. Ambiguous names are surfaced for
 * review instead of being silently dropped — losing a paying customer is far
 * worse than one manual check.
 */
function decide(
  cleanedName: string,
  total: number,
  membership: MemberCounts,
): { decision: CohortDecision; reason: string } {
  if (membership.members >= FALLBACK_BUCKET_MEMBERS) {
    return {
      decision: "exclude",
      reason: `signup fallback bucket (${membership.members} members)`,
    };
  }
  if (cleanedName.length === 0) {
    return { decision: "exclude", reason: "no company name" };
  }
  if (looksLikeTestName(cleanedName)) {
    return { decision: "exclude", reason: "test/demo name pattern" };
  }
  if (total === 0) {
    return { decision: "exclude", reason: "no activity" };
  }
  if (looksLikeFreemailName(cleanedName)) {
    return {
      decision: "review",
      reason: "named after a consumer mail domain — real person, unclear firm",
    };
  }
  if (looksLikeDomainName(cleanedName)) {
    return {
      decision: "review",
      reason: "name auto-derived from email domain — may still be a real firm",
    };
  }
  return { decision: "include", reason: `active (${total} signals)` };
}

export function buildCohort(input: CohortInput): CohortReport {
  const entries: CohortEntry[] = input.companies.map((company) => {
    const activity = input.activityByCompany.get(company.id) ?? EMPTY_ACTIVITY;
    const membership =
      input.membershipByCompany.get(company.id) ?? EMPTY_MEMBERSHIP;
    const cleanedName = cleanCompanyName(company.name);
    const total = activityTotal(activity);
    const { decision, reason } = decide(cleanedName, total, membership);

    return {
      companyId: company.id,
      name: company.name ?? "",
      cleanedName,
      domain: company.domain ?? company.company_domain ?? null,
      createdAt: company.created_at,
      decision,
      reason,
      activityTotal: total,
      activity,
      membership,
    };
  });

  const mergeProposals = proposeMerges(entries);
  const entryById = new Map(entries.map((entry) => [entry.companyId, entry]));

  for (const proposal of mergeProposals) {
    const group = [proposal.survivorId, ...proposal.absorbedIds]
      .map((id) => entryById.get(id))
      .filter((entry): entry is CohortEntry => entry !== undefined);

    // A duplicate row with a real company name is proof the tenant is a real
    // firm, so the whole group graduates out of review — there is nothing left
    // for a human to decide once one of its names is unambiguous.
    if (group.some((entry) => entry.decision === "include")) {
      for (const entry of group) {
        if (entry.decision === "review") {
          entry.decision = "include";
          entry.reason = `identified via duplicate "${proposal.preferredName}"`;
        }
      }
    }

    // Absorbed companies keep their decision (their users and data still
    // migrate) but are tagged so later phases retarget them onto the survivor.
    for (const absorbed of proposal.absorbedIds) {
      const entry = entryById.get(absorbed);
      if (entry) entry.mergeInto = proposal.survivorId;
    }
  }

  // Human decisions are applied last so they outrank every rule above.
  const warnings = applyOverrides(entries, input.overrides ?? {});

  // Overrides can invalidate a merge decided before them, so the proposals are
  // recomputed against the final decisions rather than left pointing at
  // companies that are no longer migrating.
  const pruned = pruneMergeProposals(mergeProposals, entryById);
  warnings.push(...pruned.warnings);

  entries.sort((a, b) => b.activityTotal - a.activityTotal);

  const included = entries.filter((entry) => entry.decision === "include");
  const review = entries.filter((entry) => entry.decision === "review");

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      sourceCompanies: input.companies.length,
      sourceProfiles: input.profiles.length,
      include: included.length,
      review: review.length,
      exclude: entries.length - included.length - review.length,
      usersInCohort: included.reduce(
        (sum, entry) => sum + entry.membership.members,
        0,
      ),
    },
    signedOffBy: null,
    entries,
    mergeProposals: pruned.proposals,
    warnings,
  };
}

/**
 * Re-derives merge proposals after human overrides, so no proposal names a
 * company that is no longer migrating and no entry points at an excluded
 * survivor. A merge that loses all but one member simply stops being a merge.
 */
export function pruneMergeProposals(
  proposals: MergeProposal[],
  entryById: Map<string, CohortEntry>,
): { proposals: MergeProposal[]; warnings: string[] } {
  const kept: MergeProposal[] = [];
  const warnings: string[] = [];

  for (const proposal of proposals) {
    const group = [proposal.survivorId, ...proposal.absorbedIds]
      .map((id) => entryById.get(id))
      .filter((entry): entry is CohortEntry => entry !== undefined);

    // Rebuilt below for whoever is left; stale links must not survive.
    for (const entry of group) entry.mergeInto = undefined;

    const surviving = group.filter((entry) => entry.decision !== "exclude");
    if (surviving.length < 2) {
      if (surviving.length === 1 && group.length > 1) {
        warnings.push(
          `"${surviving[0].cleanedName}" no longer merges with anything — ` +
            `its duplicate was excluded`,
        );
      }
      continue;
    }

    const rebuilt = buildProposal(surviving, proposal.matchKey);
    for (const absorbedId of rebuilt.absorbedIds) {
      const entry = entryById.get(absorbedId);
      if (entry) entry.mergeInto = rebuilt.survivorId;
    }
    kept.push(rebuilt);
  }

  return { proposals: kept, warnings };
}

/**
 * Applies human decisions in place and returns anything a person should look
 * at. Overrides that match nothing are reported rather than ignored — a typo in
 * the file would otherwise silently migrate a company someone meant to drop.
 */
export function applyOverrides(
  entries: CohortEntry[],
  overrides: CohortOverrides,
): string[] {
  const warnings: string[] = [];
  const byId = new Map(entries.map((entry) => [entry.companyId, entry]));
  const byName = new Map(entries.map((entry) => [entry.cleanedName, entry]));

  for (const [key, override] of Object.entries(overrides)) {
    const entry = byId.get(key) ?? byName.get(key);
    if (!entry) {
      warnings.push(`override "${key}" matched no company — check the spelling`);
      continue;
    }
    entry.decision = override.decision;
    entry.reason = `${override.reason} (override by ${override.by})`;
    entry.overriddenBy = override.by;
  }

  // Merges broken by these decisions are repaired by `pruneMergeProposals`.
  return warnings;
}

/**
 * Groups companies that are almost certainly the same firm entered twice.
 * Only candidates that would actually migrate are considered — merging two
 * excluded shells is noise.
 */
export function proposeMerges(entries: CohortEntry[]): MergeProposal[] {
  const groups = new Map<string, CohortEntry[]>();

  for (const entry of entries) {
    if (entry.decision === "exclude") continue;
    const key = mergeKey(entry.cleanedName);
    if (key.length < 3) continue;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }

  const proposals: MergeProposal[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    proposals.push(buildProposal(group, key));
  }

  return proposals.sort((a, b) => a.survivorName.localeCompare(b.survivorName));
}

/**
 * Shared by the initial pass and the post-override prune so both always agree
 * on who survives and what the merged company ends up called.
 */
function buildProposal(group: CohortEntry[], matchKey: string): MergeProposal {
  // The survivor is the busiest row because it carries the richest profile;
  // the name is chosen separately, since the busiest row is often the one
  // signup named after an email domain.
  const [survivor, ...absorbed] = [...group].sort(
    (a, b) => b.activityTotal - a.activityTotal,
  );

  const named = group
    .filter(
      (entry) =>
        !looksLikeDomainName(entry.cleanedName) &&
        !looksLikeFreemailName(entry.cleanedName),
    )
    // Prefer the most descriptive real name ("HNS Bau GmbH" over "HNS").
    .sort((a, b) => b.cleanedName.length - a.cleanedName.length);

  return {
    survivorId: survivor.companyId,
    survivorName: survivor.cleanedName,
    preferredName: named[0]?.cleanedName ?? survivor.cleanedName,
    absorbedIds: absorbed.map((entry) => entry.companyId),
    absorbedNames: absorbed.map((entry) => entry.cleanedName),
    matchKey,
  };
}
