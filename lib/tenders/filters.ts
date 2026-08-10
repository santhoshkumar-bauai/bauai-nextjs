/**
 * Shared tender filter model — the single source of truth for filter values,
 * used by the list/geo API routes, the client filter UI, and saved presets.
 *
 * Filters chosen for real utility against the seeded corpus:
 *  - status: OPEN / CLOSING_SOON / UPCOMING
 *  - contract type (contractNature): works / services / supplies
 *  - sector (CPV division prefix): construction, engineering, IT, …
 *  - region (NUTS-1 German state prefix)
 *  - deadline within N days
 *  - minimum relevance (match %)
 *
 * Budget range is intentionally omitted: only ~8.5% of opportunities carry an
 * estimatedValue, so a hard budget filter would hide the vast majority.
 */
import { OPPORTUNITY_STATUSES } from "@/lib/tenders/relevance";

export const CONTRACT_NATURES = ["works", "services", "supplies"] as const;
export type ContractNature = (typeof CONTRACT_NATURES)[number];

/** CPV divisions with the most opportunities, curated for the sector picker. */
export const SECTOR_DIVISIONS = [
  "45", // construction
  "71", // architecture & engineering
  "72", // IT services
  "48", // software
  "90", // environmental services
  "79", // business services
  "44", // construction materials
  "43", // machinery
  "34", // transport equipment
  "31", // electrical equipment
  "39", // furniture & furnishings
  "77", // agriculture & landscaping
] as const;

/** German NUTS-1 state codes for the location picker. */
export const GERMAN_REGION_CODES = [
  "DE1", // Baden-Württemberg
  "DE2", // Bayern
  "DE3", // Berlin
  "DE4", // Brandenburg
  "DE5", // Bremen
  "DE6", // Hamburg
  "DE7", // Hessen
  "DE8", // Mecklenburg-Vorpommern
  "DE9", // Niedersachsen
  "DEA", // Nordrhein-Westfalen
  "DEB", // Rheinland-Pfalz
  "DEC", // Saarland
  "DED", // Sachsen
  "DEE", // Sachsen-Anhalt
  "DEF", // Schleswig-Holstein
  "DEG", // Thüringen
] as const;

export const DEADLINE_DAY_OPTIONS = [7, 14, 30, 60] as const;

/**
 * Result ordering. All of these reorder the *same* relevance-ranked pool, so a
 * deadline sort still means "my most relevant tenders, soonest first" rather
 * than "every tender in the corpus by deadline".
 */
export const SORT_OPTIONS = ["relevance", "deadline", "newest", "nearest"] as const;
export type TenderSort = (typeof SORT_OPTIONS)[number];
export const DEFAULT_SORT: TenderSort = "relevance";

export interface TenderFilters {
  q?: string;
  statuses: string[];
  contractNatures: string[];
  /** CPV division prefixes, e.g. ["45","71"]. */
  sectors: string[];
  /** NUTS-1 prefixes, e.g. ["DE3","DEA"]. */
  regions: string[];
  /** Only tenders with a deadline within this many days. */
  deadlineInDays?: number;
  /** Minimum composite relevance score, 0..1. */
  minScore?: number;
  /** Result ordering; `relevance` is the default and is never serialized. */
  sort?: TenderSort;
}

export const EMPTY_FILTERS: TenderFilters = {
  statuses: [],
  contractNatures: [],
  sectors: [],
  regions: [],
};

function list(params: URLSearchParams, name: string): string[] {
  return (params.get(name) ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function intersect(values: string[], allowed: readonly string[]): string[] {
  const set = new Set(allowed);
  return [...new Set(values)].filter((v) => set.has(v));
}

/** Parse + validate filters from a URL query string (route boundary). */
export function parseTenderFilters(params: URLSearchParams): TenderFilters {
  const q = params.get("q")?.trim().slice(0, 120) || undefined;

  const statuses = intersect(
    list(params, "status").map((s) => s.toUpperCase()),
    OPPORTUNITY_STATUSES as readonly string[],
  );
  const contractNatures = intersect(
    list(params, "contract").map((s) => s.toLowerCase()),
    CONTRACT_NATURES,
  );
  const sectors = intersect(list(params, "sector"), SECTOR_DIVISIONS);
  const regions = intersect(
    list(params, "region").map((s) => s.toUpperCase()),
    GERMAN_REGION_CODES,
  );

  const deadlineRaw = Number.parseInt(params.get("deadlineInDays") ?? "", 10);
  const deadlineInDays =
    Number.isFinite(deadlineRaw) && deadlineRaw > 0
      ? Math.min(365, deadlineRaw)
      : undefined;

  const minScoreRaw = Number.parseFloat(params.get("minScore") ?? "");
  const minScore = Number.isFinite(minScoreRaw)
    ? Math.min(1, Math.max(0, minScoreRaw))
    : undefined;

  const sortRaw = params.get("sort") ?? "";
  const sort = (SORT_OPTIONS as readonly string[]).includes(sortRaw)
    ? (sortRaw as TenderSort)
    : undefined;

  return {
    q,
    statuses,
    contractNatures,
    sectors,
    regions,
    deadlineInDays,
    minScore,
    sort,
  };
}

/** Coerce an untrusted object (saved-preset body) into a safe TenderFilters. */
export function normalizeTenderFilters(raw: unknown): TenderFilters {
  const record = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

  const params = new URLSearchParams();
  if (typeof record.q === "string") params.set("q", record.q);
  if (arr(record.statuses).length) params.set("status", arr(record.statuses).join(","));
  if (arr(record.contractNatures).length)
    params.set("contract", arr(record.contractNatures).join(","));
  if (arr(record.sectors).length) params.set("sector", arr(record.sectors).join(","));
  if (arr(record.regions).length) params.set("region", arr(record.regions).join(","));
  if (typeof record.deadlineInDays === "number")
    params.set("deadlineInDays", String(record.deadlineInDays));
  if (typeof record.minScore === "number")
    params.set("minScore", String(record.minScore));
  if (typeof record.sort === "string") params.set("sort", record.sort);

  return parseTenderFilters(params);
}

/** Serialize filters into query params (client fetch + preset apply). */
export function tenderFiltersToParams(
  filters: TenderFilters,
  extra?: Record<string, string>,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.statuses.length) params.set("status", filters.statuses.join(","));
  if (filters.contractNatures.length)
    params.set("contract", filters.contractNatures.join(","));
  if (filters.sectors.length) params.set("sector", filters.sectors.join(","));
  if (filters.regions.length) params.set("region", filters.regions.join(","));
  if (filters.deadlineInDays) params.set("deadlineInDays", String(filters.deadlineInDays));
  if (typeof filters.minScore === "number" && filters.minScore > 0)
    params.set("minScore", String(filters.minScore));
  if (filters.sort && filters.sort !== DEFAULT_SORT) params.set("sort", filters.sort);
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
  return params;
}

/** Number of active filter facets (for the UI badge). q is counted too. */
export function activeFilterCount(filters: TenderFilters): number {
  return (
    (filters.q ? 1 : 0) +
    filters.statuses.length +
    filters.contractNatures.length +
    filters.sectors.length +
    filters.regions.length +
    (filters.deadlineInDays ? 1 : 0) +
    (filters.minScore && filters.minScore > 0 ? 1 : 0)
  );
}

/**
 * One entry per active filter *value*, so the chip row can drop a single value
 * without clearing its whole facet. `field` + `value` is enough for the caller
 * to reverse the choice; labels stay in the component, which owns `t`.
 */
export type ActiveFilterChip =
  | { key: string; field: "q" }
  | { key: string; field: "deadlineInDays" }
  | { key: string; field: "minScore" }
  | {
      key: string;
      field: "statuses" | "contractNatures" | "sectors" | "regions";
      value: string;
    };

export function activeFilterChips(filters: TenderFilters): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  if (filters.q) chips.push({ key: "q", field: "q" });
  for (const value of filters.statuses)
    chips.push({ key: `statuses:${value}`, field: "statuses", value });
  for (const value of filters.contractNatures)
    chips.push({ key: `contract:${value}`, field: "contractNatures", value });
  for (const value of filters.sectors)
    chips.push({ key: `sector:${value}`, field: "sectors", value });
  for (const value of filters.regions)
    chips.push({ key: `region:${value}`, field: "regions", value });
  if (filters.deadlineInDays)
    chips.push({ key: "deadline", field: "deadlineInDays" });
  if (filters.minScore && filters.minScore > 0)
    chips.push({ key: "minScore", field: "minScore" });
  return chips;
}

/** Remove one chip's value, leaving the rest of the filter state intact. */
export function removeFilterChip(
  filters: TenderFilters,
  chip: ActiveFilterChip,
): TenderFilters {
  switch (chip.field) {
    case "q":
      return { ...filters, q: undefined };
    case "deadlineInDays":
      return { ...filters, deadlineInDays: undefined };
    case "minScore":
      return { ...filters, minScore: undefined };
    default:
      return {
        ...filters,
        [chip.field]: filters[chip.field].filter((item) => item !== chip.value),
      };
  }
}
