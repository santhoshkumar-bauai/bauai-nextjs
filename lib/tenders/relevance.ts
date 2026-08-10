/**
 * Relevance ranking for the `tenders` collection.
 *
 * Builds a MongoDB aggregation that filters to real open opportunities and
 * scores each candidate on CPV/sector fit, NUTS-tier location proximity, and
 * how workable the timing is. Scores are computed, not stored; the sort is
 * fully deterministic per company snapshot so offset pagination is stable
 * within a snapshot.
 *
 * Fit dominates the blend (CPV 45% + location 35%): those decide whether the
 * company *can* bid at all. Timing is a 20% modifier, not a third of the
 * verdict — a freshly published tender in the wrong trade is still the wrong
 * trade.
 *
 * The recall filter reuses the CPV prefix-family semantics from
 * `app/api/tenders/events/route.ts` (a division such as `45` matches
 * `45232421`, i.e. a whole CPV family). Scoring is deliberately *stricter* than
 * recall: see `buildCpvPrefixSets`.
 */
import type { ObjectId } from "mongodb";

// Type-only, so this does not create a runtime cycle with `filters.ts`
// (which imports OPPORTUNITY_STATUSES from here).
import type { TenderSort } from "@/lib/tenders/filters";
import type { NutsResolution } from "@/lib/tenders/nuts";

/** Opportunity statuses worth surfacing — awards/closed/cancelled are excluded. */
export const OPPORTUNITY_STATUSES = ["OPEN", "CLOSING_SOON", "UPCOMING"] as const;

/** Business categories that represent live buying opportunities. */
export const OPPORTUNITY_CATEGORIES = [
  "OPEN_OPPORTUNITY",
  "OPEN_OR_EARLY_COMPETITION",
  "UPCOMING_OPPORTUNITY",
] as const;

/** Composite score weights — fit first, timing as a modifier. */
export const W_CPV = 0.45;
export const W_GEO = 0.35;
export const W_TIME = 0.2;

/**
 * Rank at which a text-arm hit is worth half of a perfect CPV match.
 *
 * The arm returns rank order, not a comparable score — BM25 totals depend on
 * term rarity and cannot be compared across two companies, let alone against
 * `cpvScore`. Converting rank to `k/(k+rank)` sidesteps the calibration
 * entirely and gives the curve a deliberate shape: the head of the list is
 * treated as a real capability match, the tail decays to a hint.
 */
const TEXT_RANK_HALF_LIFE = 25;

/**
 * What an AI-derived CPV code is worth relative to a buyer-assigned one.
 *
 * Derived codes (`tenders.derivedCpvCodes`) exist only where the notice
 * carried no codes at all, picked by an enum-constrained model from the
 * catalog — plausible, but never as trustworthy as what the buyer filed.
 * The discount keeps a derived-only tender from ever outscoring an
 * identically-matched properly-coded one.
 */
const DERIVED_CPV_DISCOUNT = 0.8;

/** Ranking past a few hundred results is meaningless; this also bounds sort cost. */
export const RANK_CAP = 500;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** Decay time-constant (days) for the publication-freshness curve. */
const RECENCY_TAU_DAYS = 45;
const MS_PER_DAY = 86_400_000;

// --- CPV fit tuning ---------------------------------------------------------

/**
 * Matched-prefix depth → fit score. Depth is the longest common prefix of the
 * two codes' *significant* digits, so it is capped by whichever side is
 * vaguer: two codes that agree only on the division ("45…" construction) land
 * at depth 2 no matter how many digits they nominally share.
 */
export const CPV_DEPTH_SCORE: Record<number, number> = {
  7: 1.0,
  6: 0.9,
  5: 0.78,
  4: 0.62,
  3: 0.45,
  2: 0.25,
};

/** Deepest prefix tested. CPV's 8th digit is almost always a filler zero. */
const CPV_MAX_DEPTH = 7;

/** Best single code carries the score; breadth of overlap only nudges it. */
const CPV_BEST_WEIGHT = 0.85;
const CPV_BREADTH_WEIGHT = 0.15;
/** Matching codes needed to max out the breadth term. */
const CPV_BREADTH_TARGET = 3;

// --- Location tuning --------------------------------------------------------

/**
 * NUTS tier → proximity score. NUTS2 sits high because that is as precise as
 * the corpus usually gets: most tenders carry a 4-character region ("DEA5")
 * while companies resolve all the way to NUTS3, so scoring a same-region
 * tender at NUTS2 penalises the *data*, not the tender.
 */
export const GEO_NUTS3_SCORE = 1.0;
export const GEO_NUTS2_SCORE = 0.85;
export const GEO_NUTS1_SCORE = 0.55;
export const GEO_COUNTRY_SCORE = 0.2;

/**
 * Stand-in kilometres per NUTS tier, used by the "nearest" sort when a tender
 * has no resolvable coordinates — only about half of any ranked pool carries a
 * buyer address at all.
 *
 * NUTS regions are geographic containment, so the tier *is* a coarse distance
 * measurement. Each figure sits near the outer edge of its tier's typical
 * radius rather than the middle, so a tender with a known distance sorts ahead
 * of an unlocated one from the same region instead of interleaving with it.
 */
export const GEO_TIER_DISTANCE_KM: ReadonlyArray<{ minScore: number; km: number }> = [
  { minScore: GEO_NUTS3_SCORE, km: 40 },
  { minScore: GEO_NUTS2_SCORE, km: 90 },
  { minScore: GEO_NUTS1_SCORE, km: 200 },
  { minScore: GEO_COUNTRY_SCORE, km: 600 },
];
/** Not even in the company's country. */
const GEO_TIER_DISTANCE_FALLBACK_KM = 2000;

/** Mean Earth radius in km — mirrors `lib/tenders/distance.ts`. */
const EARTH_RADIUS_KM = 6371;

// --- Timing tuning ----------------------------------------------------------

/**
 * Days-to-deadline → workability, as ascending upper bounds (exclusive).
 *
 * This is deliberately *not* an urgency curve. A tender closing in two days
 * cannot realistically be bid, so ranking it top is worse than useless; the
 * sweet spot is enough runway to assemble an offer. Callers who genuinely want
 * "closing first" have the deadline sort and the CLOSING_SOON filter.
 */
const DEADLINE_WINDOW: ReadonlyArray<{ underDays: number; score: number }> = [
  { underDays: 3, score: 0.15 },
  { underDays: 7, score: 0.5 },
  { underDays: 14, score: 0.8 },
  { underDays: 45, score: 1.0 },
  { underDays: 90, score: 0.7 },
];
/** Beyond the last window bound — real, but nothing to act on yet. */
const DEADLINE_FAR_SCORE = 0.45;
/** ~10% of DE opportunities carry no deadline at all; neutral beats zero. */
const DEADLINE_UNKNOWN_SCORE = 0.35;
const FRESHNESS_UNKNOWN_SCORE = 0.3;

const TIME_WINDOW_WEIGHT = 0.6;
const TIME_FRESHNESS_WEIGHT = 0.4;

/** Shape of each projected item coming out of the aggregation (pre-serialize). */
export interface RankedTenderRaw {
  _id: unknown;
  title: string | null;
  description: string | null;
  buyer: {
    name?: string | null;
    address?: {
      city?: string | null;
      postalCode?: string | null;
      countryCode?: string | null;
    } | null;
  } | null;
  cpvCodes: string[];
  regions: string[];
  status: string;
  submissionDeadline: Date | null;
  publicationDate: Date | null;
  estimatedValueAmount: string | null;
  estimatedValueCurrency: string | null;
  score: number;
  cpvScore: number;
  /** Rank-decayed notice-text match, 0 when the text arm did not run. */
  textScore: number;
  geoScore: number;
  timeScore: number;
  hasCoordinates: boolean;
  /** GeoJSON point, present only once this tender has been geocoded. */
  location?: { type: "Point"; coordinates: [number, number] } | null;
  procedureType: string | null;
  contractNature: string | null;
  sourceUrl: string | null;
}

/** Strip the CPV check digit and any non-digits: "45000000-7" → "45000000". */
export function stripCheckDigit(code: string): string {
  return code.split("-")[0].replace(/\D/g, "");
}

/**
 * The significant part of a CPV code — trailing filler zeros removed, never
 * shorter than the 2-digit division. "45000000" → "45" (a whole division),
 * "45233120" → "4523312" (one specific work type).
 */
export function cpvStem(code: string): string {
  const digits = stripCheckDigit(code);
  const stem = digits.replace(/0+$/, "");
  return stem.length >= 2 ? stem : digits.slice(0, 2);
}

/**
 * Reduce a company's exact CPV codes to a minimal set of family prefixes.
 * Trailing zeros are trimmed so a division-level code ("45000000") broadens to
 * its whole family ("45") while a specific code ("45233120") stays narrow
 * ("4523312"). Prefixes subsumed by a shorter one are dropped, and every prefix
 * keeps at least 2 digits (a CPV division).
 *
 * This drives *recall* only. It is intentionally generous — narrowing happens
 * in scoring, where `buildCpvPrefixSets` grades how deep the match actually is.
 */
export function toFamilyPrefixes(exactCodes: string[]): string[] {
  const trimmed = exactCodes.map(cpvStem).filter((p) => p.length >= 2);

  const unique = [...new Set(trimmed)].sort((a, b) => a.length - b.length);
  const minimal: string[] = [];
  for (const prefix of unique) {
    if (!minimal.some((kept) => prefix.startsWith(kept))) minimal.push(prefix);
  }
  return minimal;
}

/**
 * Company CPV prefixes bucketed by depth: `sets[k]` holds the first `k` digits
 * of every company code specific enough to *carry* `k` meaningful digits.
 *
 * That last condition is the whole point. A company listing "45000000" has
 * declared "we do construction", not "we do 45-something-precise", so the code
 * contributes to depth 2 and nothing deeper — it can never earn a specific
 * match. Without this, holding one division-level code awarded a perfect CPV
 * score to every tender in the division.
 */
export function buildCpvPrefixSets(exactCodes: string[]): Map<number, string[]> {
  const sets = new Map<number, string[]>();
  for (let depth = 2; depth <= CPV_MAX_DEPTH; depth += 1) {
    const prefixes = new Set<string>();
    for (const code of exactCodes) {
      if (cpvStem(code).length >= depth) prefixes.add(code.slice(0, depth));
    }
    if (prefixes.size > 0) sets.set(depth, [...prefixes]);
  }
  return sets;
}

/**
 * Significant length of the tender code bound to `$$c` — the index at which
 * its trailing zeros start, floored at the 2-digit division. Mirrors `cpvStem`
 * inside the aggregation, so a vague tender code cannot claim a deep match
 * either.
 */
const TENDER_STEM_LEN_EXPR = {
  $let: {
    vars: { zeros: { $regexFind: { input: "$$c", regex: "0+$" } } },
    in: { $max: [2, { $ifNull: ["$$zeros.idx", { $strLenCP: "$$c" }] }] },
  },
};

/** Score for one tender CPV code (`$$c`): deepest company prefix it matches. */
function cpvDepthScoreExpr(
  prefixSets: Map<number, string[]>,
): Record<string, unknown> | number {
  const branches: Record<string, unknown>[] = [];
  for (let depth = CPV_MAX_DEPTH; depth >= 2; depth -= 1) {
    const prefixes = prefixSets.get(depth);
    if (!prefixes) continue;
    branches.push({
      case: {
        $and: [
          { $gte: ["$$stemLen", depth] },
          { $in: [{ $substrCP: ["$$c", 0, depth] }, prefixes] },
        ],
      },
      then: CPV_DEPTH_SCORE[depth],
    });
  }
  if (branches.length === 0) return 0;
  return {
    $let: {
      vars: { stemLen: TENDER_STEM_LEN_EXPR },
      in: { $switch: { branches, default: 0 } },
    },
  };
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface RelevanceInputs {
  /** Company CPV codes, as stored (may include check digits). */
  companyCpvCodes: string[];
  nuts: NutsResolution;
  /** Countries to restrict to; defaults to the resolved NUTS country. */
  countries?: string[];
  /**
   * Where the company sits. Only the "nearest" sort uses it, and only to
   * sharpen the ordering: without it that sort still works, ranking by NUTS
   * tier alone.
   */
  companyPoint?: { lat: number; lng: number } | null;
}

export interface RelevanceOptions {
  now: Date;
  page: number;
  pageSize: number;
  /** Optional status subset (defaults to all opportunity statuses). */
  statuses?: string[];
  /** Optional free-text filter over title/description. */
  q?: string;
  /** Drop results below this composite score. */
  minScore?: number;
  rankCap?: number;
  /** Hard filter: contract nature (works/services/supplies). */
  contractNatures?: string[];
  /** Hard filter: CPV division prefixes, e.g. ["45","71"]. */
  sectors?: string[];
  /** Hard filter: NUTS prefixes, e.g. ["DE3","DEA"]. */
  regions?: string[];
  /** Hard filter: only tenders with a deadline within this many days. */
  deadlineInDays?: number;
  /** Ordering applied to the ranked pool; defaults to relevance. */
  sort?: TenderSort;
  /** Tender _ids to drop from the feed entirely (e.g. rejected by the company). */
  excludeIds?: ObjectId[];
  /**
   * Restrict scoring to exactly these tender _ids and skip the CPV/NUTS recall
   * clause. Used by AI matching to score its own semantically-retrieved
   * shortlist with the same cpv/geo/time expressions the classic feed uses —
   * the recall clause would defeat the point, since the whole reason a tender
   * is in that shortlist may be that CPV and NUTS both missed it.
   */
  includeIds?: ObjectId[];
  /**
   * Tenders ranked by how well the notice text matches the company profile,
   * best first — see `lib/tenders/text-arm.ts`.
   *
   * Both a recall source and a scoring signal, and it is the answer to CPV
   * being unreliable on the tender side: 14% of open tenders carry no CPV code
   * at all and cannot be reached by code matching at any threshold, while the
   * words the buyer wrote are always there. Costs nothing when omitted — the
   * feed then behaves exactly as it did before.
   */
  textRankedIds?: ObjectId[];
}

/** Sentinels that park undated tenders at the end of a date-ordered page. */
const FAR_FUTURE = new Date("9999-12-31T00:00:00.000Z");
const FAR_PAST = new Date("0001-01-01T00:00:00.000Z");

/**
 * Cache key for a tender's buyer address, mirroring `deriveKey` in
 * `lib/tenders/geocode-cache.ts` — postal code preferred, city as fallback.
 * Both sides must agree or the lookup silently misses, so keep them in step.
 */
const GEO_CACHE_KEY_EXPR = {
  $let: {
    vars: {
      country: { $toUpper: { $ifNull: ["$buyer.address.countryCode", ""] } },
      postal: { $trim: { input: { $ifNull: ["$buyer.address.postalCode", ""] } } },
      city: { $trim: { input: { $ifNull: ["$buyer.address.city", ""] } } },
    },
  in: {
      $cond: [
        { $eq: [{ $strLenCP: "$$country" }, 0] },
        null,
        {
          $cond: [
            { $gt: [{ $strLenCP: "$$postal" }, 0] },
            { $concat: ["$$country", ":", "$$postal"] },
            {
              $cond: [
                { $gt: [{ $strLenCP: "$$city" }, 0] },
                { $concat: ["$$country", ":city:", { $toLower: "$$city" }] },
                null,
              ],
            },
          ],
        },
      ],
    },
  },
};

/** Great-circle km from the company to `$resolvedPoint`, or null if unlocated. */
function haversineExpr(from: { lat: number; lng: number }): Record<string, unknown> {
  // GeoJSON stores [lng, lat]. The company's own trig terms are constants, so
  // they are folded here rather than recomputed per document.
  const lng2 = { $arrayElemAt: ["$resolvedPoint", 0] };
  const lat2 = { $arrayElemAt: ["$resolvedPoint", 1] };
  const halfDLat = {
    $divide: [{ $degreesToRadians: { $subtract: [lat2, from.lat] } }, 2],
  };
  const halfDLng = {
    $divide: [{ $degreesToRadians: { $subtract: [lng2, from.lng] } }, 2],
  };
  const a = {
    $add: [
      { $pow: [{ $sin: halfDLat }, 2] },
      {
        $multiply: [
          Math.cos((from.lat * Math.PI) / 180),
          { $cos: { $degreesToRadians: lat2 } },
          { $pow: [{ $sin: halfDLng }, 2] },
        ],
      },
    ],
  };
  return {
    $cond: [
      { $eq: [{ $size: { $ifNull: ["$resolvedPoint", []] } }, 2] },
      {
        $multiply: [
          2 * EARTH_RADIUS_KM,
          { $asin: { $min: [1, { $sqrt: a }] } },
        ],
      },
      null,
    ],
  };
}

/** Tier stand-in distance, derived from the geo score already on the document. */
const GEO_TIER_DISTANCE_EXPR = {
  $switch: {
    branches: GEO_TIER_DISTANCE_KM.map(({ minScore, km }) => ({
      case: { $gte: ["$geoScore", minScore] },
      then: km,
    })),
    default: GEO_TIER_DISTANCE_FALLBACK_KM,
  },
};

/**
 * Order the pool by how far each tender is from the company.
 *
 * Coordinates come from the tender itself where ingestion or a previous map
 * view has filled them in, otherwise from the shared postal cache — the same
 * two sources the card's "X km away" hint uses, so the ordering and the label
 * can never disagree. Neither is a Google call: an address the cache has never
 * seen falls back to its NUTS tier rather than triggering a lookup per page
 * view, which is what keeps this endpoint free.
 */
function nearestStages(
  companyPoint: { lat: number; lng: number } | null | undefined,
): Record<string, unknown>[] {
  const stages: Record<string, unknown>[] = [];

  if (companyPoint) {
    stages.push(
      { $addFields: { geoCacheKey: GEO_CACHE_KEY_EXPR } },
      {
        $lookup: {
          from: "geo_cache",
          localField: "geoCacheKey",
          foreignField: "_id",
          as: "geoCacheHit",
        },
      },
      {
        $addFields: {
          // A cache entry for an address Google could not resolve carries no
          // `location`, so it correctly falls through to the tier estimate.
          resolvedPoint: {
            $ifNull: [
              "$buyer.location.coordinates",
              { $arrayElemAt: ["$geoCacheHit.location.coordinates", 0] },
            ],
          },
        },
      },
    );
  }

  stages.push(
    {
      $addFields: {
        sortDistanceKm: companyPoint
          ? { $ifNull: [haversineExpr(companyPoint), GEO_TIER_DISTANCE_EXPR] }
          : GEO_TIER_DISTANCE_EXPR,
      },
    },
    { $sort: { sortDistanceKm: 1, score: -1, _id: 1 } },
  );
  return stages;
}

/**
 * Stages that re-order the already-ranked pool. Applied inside the `items`
 * branch of the `$facet` after the rank cap, so paging stays correct and
 * `total` is unaffected. Relevance order needs no stages — the pool is already
 * sorted that way.
 */
export function reorderStages(
  sort: TenderSort | undefined,
  companyPoint?: { lat: number; lng: number } | null,
): Record<string, unknown>[] {
  if (sort === "nearest") {
    return nearestStages(companyPoint);
  }
  if (sort === "deadline") {
    return [
      { $addFields: { sortKey: { $ifNull: ["$submissionDeadline", FAR_FUTURE] } } },
      { $sort: { sortKey: 1, score: -1, _id: 1 } },
    ];
  }
  if (sort === "newest") {
    return [
      { $addFields: { sortKey: { $ifNull: ["$publicationDate", FAR_PAST] } } },
      { $sort: { sortKey: -1, score: -1, _id: 1 } },
    ];
  }
  return [];
}

export interface BuiltRelevanceQuery {
  pipeline: Record<string, unknown>[];
  /**
   * Everything up to and including the rank cap, without the terminal `$facet`
   * — the shared prefix the map view re-projects instead of re-deriving.
   */
  rankedStages: Record<string, unknown>[];
  exactCodes: string[];
  countries: string[];
}

/**
 * Builds the ranking aggregation pipeline (a single `$facet` returning `items`
 * + `total`). Caller runs it against `mongoDatabase.collection("tenders")`.
 *
 * `total` counts every scored candidate, not just the ranked pool: the sort and
 * rank cap live inside the `items` branch so the caller can report how many
 * tenders actually match while still paging over a bounded set.
 */
export function buildRelevancePipeline(
  inputs: RelevanceInputs,
  opts: RelevanceOptions,
): BuiltRelevanceQuery {
  const exactCodes = [
    ...new Set(inputs.companyCpvCodes.map(stripCheckDigit).filter(Boolean)),
  ];
  const familyPrefixes = toFamilyPrefixes(exactCodes);
  const familyRegex =
    familyPrefixes.length > 0 ? `^(${familyPrefixes.join("|")})` : null;

  const countries =
    inputs.countries && inputs.countries.length > 0
      ? inputs.countries
      : [inputs.nuts.country];

  const statuses =
    opts.statuses && opts.statuses.length > 0
      ? opts.statuses
      : [...OPPORTUNITY_STATUSES];

  const nutsCodes = [inputs.nuts.nuts3, inputs.nuts.nuts2, inputs.nuts.nuts1].filter(
    Boolean,
  ) as string[];

  const textRankedIds = opts.textRankedIds ?? [];

  // --- Candidate filter (index-backed) ---------------------------------------
  // Every branch of this `$or` must stay indexed (`ix_derived_cpv` for the
  // derived pair) — one unindexed branch turns the whole recall into a scan.
  const recall: Record<string, unknown>[] = [];
  if (exactCodes.length) recall.push({ cpvCodes: { $in: exactCodes } });
  if (familyRegex) recall.push({ cpvCodes: { $regex: familyRegex } });
  if (exactCodes.length) recall.push({ derivedCpvCodes: { $in: exactCodes } });
  if (familyRegex) recall.push({ derivedCpvCodes: { $regex: familyRegex } });
  if (nutsCodes.length) recall.push({ regions: { $in: nutsCodes } });
  // Without this a no-CPV tender in a neighbouring region is unreachable, no
  // matter how exactly its text describes what the company does.
  if (textRankedIds.length) recall.push({ _id: { $in: textRankedIds } });

  // When the user drives with explicit content filters they are exploring beyond
  // their own profile, so the company-relevance recall must not narrow them out.
  // An explicit id set (AI matching) does the same, more strongly: the caller
  // has already decided what the candidates are.
  const explicitContent =
    Boolean(opts.includeIds) ||
    Boolean(opts.q) ||
    (opts.contractNatures?.length ?? 0) > 0 ||
    (opts.sectors?.length ?? 0) > 0 ||
    (opts.regions?.length ?? 0) > 0;

  const and: Record<string, unknown>[] = [
    { $or: [{ submissionDeadline: null }, { submissionDeadline: { $gte: opts.now } }] },
  ];

  // Recall only when there's no explicit filter; otherwise (bare profile) it
  // keeps the default "relevant to me" set from scoring the whole corpus.
  if (!explicitContent && recall.length) {
    and.push({ $or: recall });
  }
  if (opts.contractNatures?.length) {
    and.push({ contractNature: { $in: opts.contractNatures } });
  }
  if (opts.sectors?.length) {
    const safe = opts.sectors.filter((s) => /^[0-9]{2}$/.test(s));
    if (safe.length) and.push({ cpvCodes: { $regex: `^(${safe.join("|")})` } });
  }
  if (opts.regions?.length) {
    const safe = opts.regions.filter((r) => /^DE[0-9A-Z]{0,2}$/.test(r));
    if (safe.length) and.push({ regions: { $regex: `^(${safe.join("|")})` } });
  }
  if (opts.deadlineInDays) {
    const cutoff = new Date(opts.now.getTime() + opts.deadlineInDays * MS_PER_DAY);
    and.push({ submissionDeadline: { $gte: opts.now, $lte: cutoff } });
  }
  if (opts.q && opts.q.trim()) {
    const rx = escapeRegex(opts.q.trim());
    and.push({
      $or: [
        { title: { $regex: rx, $options: "i" } },
        { description: { $regex: rx, $options: "i" } },
      ],
    });
  }

  const match: Record<string, unknown> = {
    isVisible: true,
    status: { $in: statuses },
    businessCategory: { $in: [...OPPORTUNITY_CATEGORIES] },
    countries: { $in: countries },
    $and: and,
  };
  if (opts.includeIds) {
    // `$in` and `$nin` on the same field would clobber each other, so exclusion
    // is folded into the candidate set instead.
    const excluded = new Set((opts.excludeIds ?? []).map(String));
    match._id = { $in: opts.includeIds.filter((id) => !excluded.has(String(id))) };
  } else if (opts.excludeIds?.length) {
    match._id = { $nin: opts.excludeIds };
  }

  // --- Score expressions -----------------------------------------------------
  // CPV: how deep the best code match runs, nudged by how much of the tender's
  // scope the company covers.
  const depthScoreExpr = cpvDepthScoreExpr(buildCpvPrefixSets(exactCodes));

  /** The best/breadth blend over one array of tender codes. */
  const cpvScoreOverField = (fieldPath: string): Record<string, unknown> => ({
    $let: {
      vars: {
        scores: {
          $map: {
            input: { $ifNull: [fieldPath, []] },
            as: "c",
            in: depthScoreExpr,
          },
        },
      },
      in: {
        $add: [
          {
            $multiply: [
              CPV_BEST_WEIGHT,
              { $ifNull: [{ $max: "$$scores" }, 0] },
            ],
          },
          {
            $multiply: [
              CPV_BREADTH_WEIGHT,
              {
                $min: [
                  1,
                  {
                    $divide: [
                      {
                        $size: {
                          $filter: {
                            input: "$$scores",
                            as: "s",
                            cond: { $gt: ["$$s", 0] },
                          },
                        },
                      },
                      CPV_BREADTH_TARGET,
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    },
  });

  // Source codes at full value, AI-derived codes (`scripts/ai-cpv-derive.mts`,
  // written only for tenders the buyer left uncoded) at a confidence discount.
  // Max, not sum: both answer "is this the company's kind of work", and a
  // tender must never score higher for having been coded twice. Tenders
  // without the derived field cost one `$ifNull` and score exactly as before.
  const cpvScoreExpr =
    depthScoreExpr === 0
      ? 0
      : {
          $max: [
            cpvScoreOverField("$cpvCodes"),
            {
              $multiply: [
                DERIVED_CPV_DISCOUNT,
                cpvScoreOverField("$derivedCpvCodes"),
              ],
            },
          ],
        };

  // Per-region NUTS tier, then the max across the tender's regions.
  const regionTierExpr = {
    $switch: {
      branches: [
        ...(inputs.nuts.nuts3
          ? [{ case: { $eq: ["$$r", inputs.nuts.nuts3] }, then: GEO_NUTS3_SCORE }]
          : []),
        ...(inputs.nuts.nuts2
          ? [
              {
                case: { $eq: [{ $substrCP: ["$$r", 0, 4] }, inputs.nuts.nuts2] },
                then: GEO_NUTS2_SCORE,
              },
            ]
          : []),
        ...(inputs.nuts.nuts1
          ? [
              {
                case: { $eq: [{ $substrCP: ["$$r", 0, 3] }, inputs.nuts.nuts1] },
                then: GEO_NUTS1_SCORE,
              },
            ]
          : []),
        {
          case: { $eq: [{ $substrCP: ["$$r", 0, 2] }, inputs.nuts.country] },
          then: GEO_COUNTRY_SCORE,
        },
      ],
      default: 0,
    },
  };
  const geoScoreExpr = {
    $ifNull: [
      {
        $max: {
          $map: { input: "$regions", as: "r", in: regionTierExpr },
        },
      },
      0,
    ],
  };

  const daysToDeadline = {
    $divide: [{ $subtract: ["$submissionDeadline", opts.now] }, MS_PER_DAY],
  };
  const windowExpr = {
    $cond: [
      { $eq: [{ $ifNull: ["$submissionDeadline", null] }, null] },
      DEADLINE_UNKNOWN_SCORE,
      {
        $switch: {
          branches: DEADLINE_WINDOW.map(({ underDays, score }) => ({
            case: { $lt: [daysToDeadline, underDays] },
            then: score,
          })),
          default: DEADLINE_FAR_SCORE,
        },
      },
    ],
  };
  const daysSincePub = {
    $divide: [{ $subtract: [opts.now, "$publicationDate"] }, MS_PER_DAY],
  };
  const freshnessExpr = {
    $cond: [
      { $eq: [{ $ifNull: ["$publicationDate", null] }, null] },
      FRESHNESS_UNKNOWN_SCORE,
      { $exp: { $multiply: [-1, { $divide: [{ $max: [0, daysSincePub] }, RECENCY_TAU_DAYS] }] } },
    ],
  };
  const timeScoreExpr = {
    $add: [
      { $multiply: [TIME_WINDOW_WEIGHT, windowExpr] },
      { $multiply: [TIME_FRESHNESS_WEIGHT, freshnessExpr] },
    ],
  };

  // Rank in the text arm → 0..1, decaying from the head of the list. `-1` from
  // `$indexOfArray` means the arm never returned it, which scores zero rather
  // than penalising: plenty of good matches are found by CPV alone.
  const textScoreExpr = textRankedIds.length
    ? {
        $let: {
          vars: { rank: { $indexOfArray: [textRankedIds, "$_id"] } },
          in: {
            $cond: [
              { $lt: ["$$rank", 0] },
              0,
              {
                $divide: [
                  TEXT_RANK_HALF_LIFE,
                  { $add: [TEXT_RANK_HALF_LIFE, "$$rank"] },
                ],
              },
            ],
          },
        },
      }
    : 0;

  /**
   * Capability fit is the better of the two evidence sources, not their sum.
   *
   * They are two ways of answering one question — "is this our kind of work?"
   * — and either can answer it alone. Taking the max means a tender filed with
   * no CPV code can still score a full capability match on its text, while
   * every tender that scored well on CPV before scores exactly the same now.
   * Adding them instead would double-count the tenders where both agree, which
   * is precisely the well-coded, easy-to-find work that needs no help.
   */
  const fitScoreExpr =
    textScoreExpr === 0
      ? "$cpvScore"
      : { $max: ["$cpvScore", "$textScore"] };

  const rankCap = opts.rankCap ?? RANK_CAP;
  const skip = opts.page * opts.pageSize;

  // Scored candidates — everything that survives the hard filter and the
  // optional match-percentage floor, before any ordering.
  const scoredStages: Record<string, unknown>[] = [
    { $match: match },
    {
      $addFields: {
        cpvScore: cpvScoreExpr,
        textScore: textScoreExpr,
        geoScore: geoScoreExpr,
        timeScore: timeScoreExpr,
      },
    },
    { $addFields: { fitScore: fitScoreExpr } },
    {
      $addFields: {
        score: {
          $add: [
            { $multiply: [W_CPV, "$fitScore"] },
            { $multiply: [W_GEO, "$geoScore"] },
            { $multiply: [W_TIME, "$timeScore"] },
          ],
        },
      },
    },
    ...(typeof opts.minScore === "number"
      ? [{ $match: { score: { $gte: opts.minScore } } }]
      : []),
  ];

  const rankedStages: Record<string, unknown>[] = [
    ...scoredStages,
    { $sort: { score: -1, submissionDeadline: 1, _id: 1 } },
    { $limit: rankCap },
  ];

  const pipeline: Record<string, unknown>[] = [
    ...scoredStages,
    {
      $facet: {
        items: [
          { $sort: { score: -1, submissionDeadline: 1, _id: 1 } },
          { $limit: rankCap },
          // Re-order *within* the ranked pool: "sort by deadline" means the
          // company's relevant tenders soonest-first, not the whole corpus.
          // Undated tenders sort last either way (missing keys are pushed by
          // the coalesced sort key below).
          ...reorderStages(opts.sort, inputs.companyPoint),
          { $skip: skip },
          { $limit: opts.pageSize },
          {
            $project: {
              _id: 1,
              title: 1,
              description: { $substrCP: [{ $ifNull: ["$description", ""] }, 0, 400] },
              "buyer.name": 1,
              "buyer.address.city": 1,
              "buyer.address.postalCode": 1,
              "buyer.address.countryCode": 1,
              cpvCodes: 1,
              regions: 1,
              status: 1,
              submissionDeadline: 1,
              publicationDate: 1,
              estimatedValueAmount: { $toString: "$estimatedValue.amount" },
              estimatedValueCurrency: "$estimatedValue.currency",
              score: 1,
              cpvScore: 1,
              textScore: 1,
              geoScore: 1,
              timeScore: 1,
              hasCoordinates: {
                $cond: [{ $ifNull: ["$buyer.location", false] }, true, false],
              },
              location: "$buyer.location",
              procedureType: 1,
              contractNature: 1,
              sourceUrl: { $ifNull: [{ $arrayElemAt: ["$sourceLinks.url", 0] }, null] },
            },
          },
        ],
        // Counts every match, not just the ranked pool — the feed reports how
        // much is out there even though only `rankCap` of it is pageable.
        total: [{ $count: "value" }],
      },
    },
  ];

  return { pipeline, rankedStages, exactCodes, countries };
}

/** Max markers a single `/geo` request will rank and attempt to geocode. */
export const MARKER_CAP = 60;

export interface GeoQueryOptions {
  now: Date;
  statuses?: string[];
  q?: string;
  minScore?: number;
  markerCap?: number;
  contractNatures?: string[];
  sectors?: string[];
  regions?: string[];
  deadlineInDays?: number;
}

/** Projected shape for map markers (pre-geocode fill). */
export interface RankedGeoRaw {
  _id: unknown;
  title: string | null;
  status: string;
  submissionDeadline: Date | null;
  score: number;
  buyerName: string | null;
  countryCode: string | null;
  postalCode: string | null;
  city: string | null;
  location: { type: "Point"; coordinates: [number, number] } | null;
}

/**
 * Same candidate + scoring stages as the list, capped to the top `markerCap`
 * and re-projected for the map. Reuses `buildRelevancePipeline`'s ranked
 * prefix, so the ranking logic stays defined in exactly one place.
 */
export function buildGeoPipeline(
  inputs: RelevanceInputs,
  opts: GeoQueryOptions,
): { pipeline: Record<string, unknown>[]; exactCodes: string[]; countries: string[] } {
  const markerCap = opts.markerCap ?? MARKER_CAP;
  const { rankedStages, exactCodes, countries } = buildRelevancePipeline(inputs, {
    now: opts.now,
    page: 0,
    pageSize: markerCap,
    statuses: opts.statuses,
    q: opts.q,
    minScore: opts.minScore,
    rankCap: markerCap,
    contractNatures: opts.contractNatures,
    sectors: opts.sectors,
    regions: opts.regions,
    deadlineInDays: opts.deadlineInDays,
  });
  const pipeline = [
    ...rankedStages,
    {
      $project: {
        _id: 1,
        title: 1,
        status: 1,
        submissionDeadline: 1,
        score: 1,
        buyerName: "$buyer.name",
        countryCode: "$buyer.address.countryCode",
        postalCode: "$buyer.address.postalCode",
        city: "$buyer.address.city",
        location: "$buyer.location",
      },
    },
  ];
  return { pipeline, exactCodes, countries };
}
