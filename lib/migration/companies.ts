/**
 * Transforms a legacy `companies` row into the shape `models/company.ts`
 * defines. Pure — no database, no network — so every rule below is unit tested
 * against the real production shapes.
 *
 * The legacy column types do not match their names, which is most of the work
 * here. Observed on the migrating cohort (2026-08-12):
 *
 *   trade               a JSON *string*: "[\"Hochbau\",\"Construction\"]"
 *   project_size_range  a JSON *string*: "{\"min\":\"300000\",\"max\":...}"
 *   cpv_codes           code + label:    "33697110-6 - Knochenzemente"
 *   bank_details        an all-null shell: {"iban":null,"bic":null,...}
 *   insurances          empty rows:      [{"type":"","amount":"","details":""}]
 *   company_type        trailing CRLF:   "construction_firm\r\n"
 *   knowledge_base      snake_case keys the target spells in camelCase
 *
 * Writing any of those through unchanged would produce a company that loads but
 * cannot be matched: bare labels never match a CPV prefix, and an insurance row
 * with an empty `type` violates a field the schema marks required.
 */
import { normalizeCompanyWebsite } from "../validation/company-website.ts";
import { looksLikeDomainName as looksLikeDomainLabel } from "./cohort.ts";

/** Loosely typed legacy row — every column is suspect until coerced. */
export interface SourceCompanyRow {
  id: string;
  name?: string | null;
  domain?: string | null;
  company_domain?: string | null;
  company_domain_other?: string | null;
  website?: string | null;
  company_website?: string | null;
  company_type?: string | null;
  trade?: unknown;
  region?: unknown;
  specializations?: unknown;
  certifications?: unknown;
  cpv_codes?: unknown;
  address?: string | null;
  address_coordinates?: unknown;
  employee_count?: unknown;
  vat_number?: string | null;
  registration_number?: string | null;
  phone?: string | null;
  email?: string | null;
  bank_details?: unknown;
  insurances?: unknown;
  reference_projects?: unknown;
  knowledge_base?: unknown;
  project_size_range?: unknown;
  logo_url?: string | null;
  created_at?: string | null;
}

export interface BankDetails {
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
  iban?: string;
  bic?: string;
}

export interface InsuranceInfo {
  type: string;
  amount: string;
  details?: string;
}

export interface ReferenceProject {
  title: string;
  description: string;
  client?: string;
  year?: string;
  value?: string;
}

/** The document handed to the raw driver. Mirrors models/company.ts. */
export interface CompanyDocument {
  name: string;
  domain: string;
  website: string;
  businessDomain: string;
  region: string;
  regionLocation?: { placeId?: string; latitude: number; longitude: number };
  services: string[];
  cpvCodes: string[];
  companyDomain?: string;
  companyDomainOther?: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  registrationNumber?: string;
  address?: string;
  addressCoordinates?: { lat: number; lng: number };
  trade: string[];
  specializations: string[];
  certifications: string[];
  projectSizeRange?: { min?: string; max?: string };
  employeeCount?: number;
  bankDetails?: BankDetails;
  insurances: InsuranceInfo[];
  referenceProjects: ReferenceProject[];
  knowledgeBase?: Record<string, unknown>;
  members: never[];
  membershipRequests: never[];
  trial: { status: "active" | "expired"; startsAt: Date; endsAt: Date };
  createdBy: string;
}

/** Business domains offered at onboarding (`data/onboarding-catalog.ts`). */
export const BUSINESS_DOMAINS = [
  "CONSTRUCTION", "EQUIPMENT_SUPPLIER", "MATERIAL_SUPPLIER", "HANDWERK",
  "ARCHITECTURE", "ENGINEERING", "SUBCONTRACTOR", "FACILITY_MANAGEMENT", "OTHER",
] as const;

const COMPANY_TYPE_TO_DOMAIN: Record<string, string> = {
  construction_firm: "CONSTRUCTION",
  engineering_firm: "ENGINEERING",
  architect_firm: "ARCHITECTURE",
  equipment_supplier: "EQUIPMENT_SUPPLIER",
  material_supplier: "MATERIAL_SUPPLIER",
  subcontractor: "SUBCONTRACTOR",
  facility_management: "FACILITY_MANAGEMENT",
  handwerk: "HANDWERK",
  other: "OTHER",
};

/**
 * Ordered German-first keyword rules for companies whose `company_type` is
 * blank — 78% of the cohort. First match wins, so the most specific trades come
 * before the generic "Bau".
 */
const TRADE_KEYWORD_DOMAIN: Array<[RegExp, string]> = [
  [/architekt/i, "ARCHITECTURE"],
  [/ingenieur|tragwerk|statik|planung|bauphysik|vermessung|gutacht/i, "ENGINEERING"],
  [/handel|lieferant|großhandel|fachhandel|baustoff/i, "MATERIAL_SUPPLIER"],
  [/vermietung|geräte|maschinen/i, "EQUIPMENT_SUPPLIER"],
  [/facility|gebäudemanagement|reinigung|hausmeister/i, "FACILITY_MANAGEMENT"],
  [/nachunternehmer|subunternehmer/i, "SUBCONTRACTOR"],
  [/maler|fliesen|trockenbau|sanitär|elektro|dach|zimmerer|schreiner|metallbau|handwerk/i, "HANDWERK"],
  [/bau|hochbau|tiefbau|rohbau|sanierung|abbruch/i, "CONSTRUCTION"],
];

/** Legacy JSON columns arrive as strings about half the time. */
export function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/** Accepts an array, a JSON-encoded array, or a delimited string. */
export function toStringArray(value: unknown): string[] {
  const parsed = parseJsonMaybe(value);
  if (parsed === null || parsed === undefined) return [];

  const raw = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "string"
      ? parsed.split(/[,;|]/)
      : [];

  return [
    ...new Set(
      raw
        .filter((item): item is string => typeof item === "string")
        // Trailing CRLF is common in this data.
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Pulls the bare CPV code out of a legacy entry. Ranking matches on code
 * prefixes, so "33697110-6 - Knochenzemente" must become "33697110-6" or the
 * company matches nothing.
 */
export function extractCpvCode(entry: string): string | null {
  const withCheckDigit = entry.match(/\b(\d{8}-\d)\b/);
  if (withCheckDigit) return withCheckDigit[1];
  // A code missing its check digit cannot be repaired here; the script resolves
  // it against the CPV catalog and reports whatever is left unresolved.
  const bare = entry.match(/\b(\d{8})\b/);
  return bare ? bare[1] : null;
}

export function toCpvCodes(value: unknown): {
  codes: string[];
  unresolved: string[];
} {
  const codes: string[] = [];
  const unresolved: string[] = [];

  for (const entry of toStringArray(value)) {
    const code = extractCpvCode(entry);
    if (code && /^\d{8}-\d$/.test(code)) codes.push(code);
    else unresolved.push(entry);
  }

  return { codes: [...new Set(codes)], unresolved };
}

/**
 * Resolves the onboarding business domain, in descending order of authority:
 *
 *  1. `company_domain` — despite the name this is not a web domain, it is the
 *     same enum the new onboarding form uses, and it is set on 100% of the
 *     migrating cohort. An explicit user choice beats any inference.
 *  2. `company_type` — an older, sparser column (22% populated).
 *  3. German trade keywords, for rows with neither.
 */
export function mapBusinessDomain(
  companyDomain: unknown,
  companyType: unknown,
  trades: string[],
): { domain: string; inferred: boolean } {
  const declared =
    typeof companyDomain === "string" ? companyDomain.trim().toUpperCase() : "";
  if ((BUSINESS_DOMAINS as readonly string[]).includes(declared)) {
    return { domain: declared, inferred: false };
  }

  const normalizedType =
    typeof companyType === "string" ? companyType.trim().toLowerCase() : "";
  const mapped = COMPANY_TYPE_TO_DOMAIN[normalizedType];
  if (mapped) return { domain: mapped, inferred: false };

  const haystack = trades.join(" ");
  for (const [pattern, domain] of TRADE_KEYWORD_DOMAIN) {
    if (pattern.test(haystack)) return { domain, inferred: true };
  }

  return { domain: "OTHER", inferred: true };
}

/** An all-null shell is not bank details; writing it would fake a filled profile. */
export function cleanBankDetails(value: unknown): BankDetails | undefined {
  const parsed = parseJsonMaybe(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const source = parsed as Record<string, unknown>;
  const text = (key: string) => {
    const raw = source[key];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };

  const details: BankDetails = {
    bankName: text("bank_name") ?? text("bankName"),
    accountNumber: text("account_number") ?? text("accountNumber"),
    accountHolder: text("account_holder") ?? text("accountHolder"),
    iban: text("iban"),
    bic: text("bic"),
  };

  const filled = Object.fromEntries(
    Object.entries(details).filter(([, entry]) => entry !== undefined),
  );
  return Object.keys(filled).length > 0 ? (filled as BankDetails) : undefined;
}

/** The schema marks type and amount required, so empty rows must not migrate. */
export function cleanInsurances(value: unknown): InsuranceInfo[] {
  const parsed = parseJsonMaybe(value);
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const type = typeof row.type === "string" ? row.type.trim() : "";
    const amount = typeof row.amount === "string" ? row.amount.trim() : "";
    if (!type || !amount) return [];
    const details = typeof row.details === "string" ? row.details.trim() : "";
    return [{ type, amount, ...(details ? { details } : {}) }];
  });
}

/** Same reasoning as insurances: title and description are required. */
export function cleanReferenceProjects(value: unknown): ReferenceProject[] {
  const parsed = parseJsonMaybe(value);
  if (!Array.isArray(parsed)) return [];

  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const text = (key: string) =>
      typeof row[key] === "string" ? (row[key] as string).trim() : "";

    const title = text("title");
    const description = text("description");
    if (!title && !description) return [];

    const optional = {
      client: text("client") || undefined,
      year: text("year") || undefined,
      value: text("value") || undefined,
    };

    return [
      {
        title: title || description.slice(0, 80),
        description: description || title,
        ...Object.fromEntries(
          Object.entries(optional).filter(([, entry]) => entry !== undefined),
        ),
      },
    ];
  });
}

const snakeToCamel = (key: string) =>
  key.replace(/_([a-z0-9])/g, (_, character: string) => character.toUpperCase());

/** The knowledge base groups the target accepts; anything else is dropped. */
const KNOWLEDGE_BASE_GROUPS = new Set([
  "companyExtended", "principalOffice", "mailingAddress", "contactInfo",
  "primaryContact", "authorizedSigner", "financialInfo", "bankExtended",
  "insuranceDetails", "bonding", "businessCertifications", "technicalNarratives",
]);

/**
 * Rewrites the legacy snake_case knowledge base into the typed camelCase shape,
 * keeping only the groups the schema declares. Unknown groups are returned
 * rather than silently discarded so the migration report can show what was lost.
 */
export function mapKnowledgeBase(value: unknown): {
  knowledgeBase?: Record<string, unknown>;
  droppedGroups: string[];
} {
  const parsed = parseJsonMaybe(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { droppedGroups: [] };
  }

  const result: Record<string, unknown> = {};
  const droppedGroups: string[] = [];

  for (const [rawGroup, rawFields] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const group = snakeToCamel(rawGroup);
    if (!KNOWLEDGE_BASE_GROUPS.has(group)) {
      droppedGroups.push(rawGroup);
      continue;
    }
    if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
      continue;
    }

    const fields: Record<string, unknown> = {};
    for (const [rawKey, rawValue] of Object.entries(
      rawFields as Record<string, unknown>,
    )) {
      if (rawValue === null || rawValue === undefined) continue;
      if (typeof rawValue === "string" && !rawValue.trim()) continue;
      fields[snakeToCamel(rawKey)] =
        typeof rawValue === "string" ? rawValue.trim() : rawValue;
    }

    if (Object.keys(fields).length > 0) result[group] = fields;
  }

  return {
    ...(Object.keys(result).length > 0 ? { knowledgeBase: result } : {}),
    droppedGroups,
  };
}

export function toCoordinates(
  value: unknown,
): { lat: number; lng: number } | undefined {
  const parsed = parseJsonMaybe(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const source = parsed as Record<string, unknown>;
  const lat = Number(source.lat ?? source.latitude);
  const lng = Number(source.lng ?? source.longitude);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return undefined;
  return { lat, lng };
}

export function toProjectSizeRange(
  value: unknown,
): { min?: string; max?: string } | undefined {
  const parsed = parseJsonMaybe(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;

  const source = parsed as Record<string, unknown>;
  const text = (key: string) => {
    const raw = source[key];
    if (typeof raw === "number") return String(raw);
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  };

  const range = { min: text("min"), max: text("max") };
  return range.min || range.max
    ? Object.fromEntries(Object.entries(range).filter(([, item]) => item))
    : undefined;
}

/**
 * Derives the website and its domain. `domain` is unique in the target, so it
 * is the upsert key and must always be present — the legacy `domain` column is
 * the fallback when no usable URL exists.
 */
/**
 * Placeholder hosts users typed instead of a real website. One cohort company
 * has `website: "example.org"`; taking it would key a real tenant on a fake
 * domain and collide with every other row that did the same.
 */
const PLACEHOLDER_DOMAINS = new Set([
  "example.com", "example.org", "example.net", "example.de", "test.com",
  "test.de", "domain.com", "yourcompany.com", "mywebsite.com", "website.com",
  "localhost", "google.com", "gmail.com",
]);

export function isPlaceholderDomain(domain: string): boolean {
  return PLACEHOLDER_DOMAINS.has(domain.toLowerCase());
}

/**
 * Columns that may hold a web address, most trusted first. `company_domain` is
 * deliberately absent: it holds the business-domain enum ("CONSTRUCTION",
 * "OTHER"), not a web domain. `domain` leads because it is what mvp1 grouped
 * users by, so it decides ties.
 */
const SITE_COLUMNS = ["domain", "website", "company_website"] as const;

export interface SiteResolution {
  site: { website: string; domain: string } | null;
  /** Every distinct domain found, most-supported first. */
  candidates: Array<{ domain: string; votes: number }>;
  /** True when the columns disagree — worth a human's eye. */
  disagreement: boolean;
}

/**
 * Picks a tenant's domain by majority across every address column of every row
 * being merged, rather than trusting one column's priority.
 *
 * This exists because the columns lie. "WIRL INGENIEURE GMBH" has
 * `company_website: "spaceera.de"` — a different company entirely — while its
 * real address `wirl-ing.de` appears in four other fields across its two rows.
 * A strict priority order picks the typo; a vote picks the truth.
 */
export function resolveWebsiteFromRows(rows: SourceCompanyRow[]): SiteResolution {
  const votes = new Map<
    string,
    {
      domain: string;
      website: string;
      votes: number;
      /** Best (lowest) column rank seen — breaks ties between domains. */
      bestRank: number;
      /** Column the stored URL came from, so a bare host can be upgraded. */
      websiteRank: number;
    }
  >();

  for (const row of rows) {
    for (const [rank, column] of SITE_COLUMNS.entries()) {
      const raw = row[column];
      if (typeof raw !== "string" || !raw.trim()) continue;

      // Reuses the helper onboarding uses, so a migrated company's domain is
      // derived exactly the way a self-signed-up one would be.
      const normalized = normalizeCompanyWebsite(raw.trim());
      if (!normalized || isPlaceholderDomain(normalized.domain)) continue;

      const existing = votes.get(normalized.domain);
      if (existing) {
        existing.votes += 1;
        existing.bestRank = Math.min(existing.bestRank, rank);
        // The `domain` column yields a bare host; an address the user actually
        // typed is the better thing to display, so it upgrades the stored URL.
        if (existing.websiteRank === 0 && rank > 0) {
          existing.website = normalized.website;
          existing.websiteRank = rank;
        }
      } else {
        votes.set(normalized.domain, {
          domain: normalized.domain,
          website: normalized.website,
          votes: 1,
          bestRank: rank,
          websiteRank: rank,
        });
      }
    }
  }

  const ranked = [...votes.values()].sort(
    (a, b) =>
      b.votes - a.votes ||
      a.bestRank - b.bestRank ||
      a.domain.localeCompare(b.domain),
  );

  return {
    site: ranked[0] ? { website: ranked[0].website, domain: ranked[0].domain } : null,
    candidates: ranked.map((item) => ({ domain: item.domain, votes: item.votes })),
    disagreement: ranked.length > 1,
  };
}

/** Single-row convenience wrapper. */
export function resolveWebsite(row: SourceCompanyRow): {
  website: string;
  domain: string;
} | null {
  return resolveWebsiteFromRows([row]).site;
}

/**
 * Turns a domain into a display name the way onboarding does, so a company
 * whose legacy name was just its email domain reads as "Ib Burak" rather than
 * "ib-burak.de".
 */
export function humanizeDomainName(domain: string): string {
  return domain
    .split(".")[0]
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export interface CompanyMappingInput {
  row: SourceCompanyRow;
  /** Name agreed at sign-off, which may differ from the row's own. */
  name: string;
  createdBy: string;
  trialStartsAt: Date;
  trialEndsAt: Date;
  /**
   * Domain decided across all merged rows by `resolveWebsiteFromRows`. Passed
   * in because the merged row alone cannot show which column won the vote.
   */
  site?: { website: string; domain: string } | null;
}

export interface CompanyMappingResult {
  document: CompanyDocument;
  /** Anything a human should know about this row; surfaced in the report. */
  issues: string[];
}

const DEFAULT_REGION = "Deutschland";

export function toCompanyDocument(
  input: CompanyMappingInput,
): CompanyMappingResult | { document: null; issues: string[] } {
  const { row } = input;
  const issues: string[] = [];

  const site = input.site ?? resolveWebsite(row);
  if (!site) {
    return {
      document: null,
      issues: ["no usable website or domain — cannot derive the unique key"],
    };
  }

  const trade = toStringArray(row.trade);
  const { codes: cpvCodes, unresolved } = toCpvCodes(row.cpv_codes);
  if (unresolved.length > 0) {
    issues.push(`${unresolved.length} CPV entries had no parsable code`);
  }

  const business = mapBusinessDomain(row.company_domain, row.company_type, trade);
  const businessDomain = business.domain;
  if (business.inferred) {
    issues.push(`businessDomain inferred as ${businessDomain}`);
  }

  // A legacy name that is just the email domain reads badly in the product.
  const name = looksLikeDomainLabel(input.name)
    ? humanizeDomainName(site.domain)
    : input.name;
  if (name !== input.name) {
    issues.push(`renamed "${input.name}" → "${name}"`);
  }

  const region =
    typeof row.region === "string" && row.region.trim()
      ? row.region.trim()
      : DEFAULT_REGION;
  if (region === DEFAULT_REGION && typeof row.region !== "string") {
    issues.push(`region missing — defaulted to ${DEFAULT_REGION}`);
  }

  const { knowledgeBase, droppedGroups } = mapKnowledgeBase(row.knowledge_base);
  if (droppedGroups.length > 0) {
    issues.push(`knowledge base groups dropped: ${droppedGroups.join(", ")}`);
  }

  const coordinates = toCoordinates(row.address_coordinates);
  const employeeCount = Number(row.employee_count);
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;

  // `services` carries the descriptive list the matching pipeline reads; the
  // legacy trade list is the only source for it, so it feeds both fields.
  const services = trade;
  if (services.length === 0) {
    issues.push("no trade/services — AI matching will have little to work with");
  }

  const document: CompanyDocument = {
    name,
    domain: site.domain,
    website: site.website,
    businessDomain,
    region,
    ...(coordinates
      ? {
          regionLocation: {
            latitude: coordinates.lat,
            longitude: coordinates.lng,
          },
        }
      : {}),
    services,
    cpvCodes,
    ...(text(row.company_domain) ? { companyDomain: text(row.company_domain) } : {}),
    ...(text(row.company_domain_other)
      ? { companyDomainOther: text(row.company_domain_other) }
      : {}),
    ...(text(row.email) ? { email: text(row.email)!.toLowerCase() } : {}),
    ...(text(row.phone) ? { phone: text(row.phone) } : {}),
    ...(text(row.vat_number) ? { vatNumber: text(row.vat_number) } : {}),
    ...(text(row.registration_number)
      ? { registrationNumber: text(row.registration_number) }
      : {}),
    ...(text(row.address) ? { address: text(row.address) } : {}),
    ...(coordinates ? { addressCoordinates: coordinates } : {}),
    trade,
    specializations: toStringArray(row.specializations),
    certifications: toStringArray(row.certifications),
    ...(toProjectSizeRange(row.project_size_range)
      ? { projectSizeRange: toProjectSizeRange(row.project_size_range) }
      : {}),
    ...(Number.isFinite(employeeCount) && employeeCount > 0
      ? { employeeCount }
      : {}),
    ...(cleanBankDetails(row.bank_details)
      ? { bankDetails: cleanBankDetails(row.bank_details) }
      : {}),
    insurances: cleanInsurances(row.insurances),
    referenceProjects: cleanReferenceProjects(row.reference_projects),
    ...(knowledgeBase ? { knowledgeBase } : {}),
    // Filled by Phase 4, which is the first point at which target user ids exist.
    members: [],
    membershipRequests: [],
    trial: {
      status: "active",
      startsAt: input.trialStartsAt,
      endsAt: input.trialEndsAt,
    },
    createdBy: input.createdBy,
  };

  return { document, issues };
}

/**
 * Folds duplicate legacy rows into one. Arrays are unioned because each row
 * usually holds a partial profile; scalars prefer the first non-empty value in
 * the order given, so callers pass the survivor first.
 */
export function mergeSourceRows(rows: SourceCompanyRow[]): SourceCompanyRow {
  if (rows.length === 1) return rows[0];

  const merged: SourceCompanyRow = { ...rows[0] };
  const arrayColumns = ["trade", "specializations", "certifications", "cpv_codes"] as const;

  for (const column of arrayColumns) {
    const union = new Set<string>();
    for (const row of rows) {
      for (const item of toStringArray(row[column])) union.add(item);
    }
    (merged[column] as unknown) = [...union];
  }

  const scalarColumns: Array<keyof SourceCompanyRow> = [
    "name", "domain", "company_domain", "company_domain_other", "website",
    "company_website", "company_type", "region", "address", "vat_number",
    "registration_number", "phone", "email", "logo_url", "created_at",
  ];

  for (const column of scalarColumns) {
    if (typeof merged[column] === "string" && (merged[column] as string).trim()) continue;
    const replacement = rows.find(
      (row) => typeof row[column] === "string" && (row[column] as string).trim(),
    );
    if (replacement) (merged[column] as unknown) = replacement[column];
  }

  const objectColumns: Array<keyof SourceCompanyRow> = [
    "address_coordinates", "employee_count", "bank_details", "insurances",
    "reference_projects", "knowledge_base", "project_size_range",
  ];

  for (const column of objectColumns) {
    const richest = rows.find((row) => {
      const parsed = parseJsonMaybe(row[column]);
      if (parsed === null || parsed === undefined) return false;
      if (Array.isArray(parsed)) return parsed.length > 0;
      if (typeof parsed === "object") return Object.keys(parsed).length > 0;
      return true;
    });
    if (richest) (merged[column] as unknown) = richest[column];
  }

  return merged;
}
