/**
 * Relevance ranking for the `tenders` collection.
 *
 * Builds a MongoDB aggregation that filters to real open opportunities and
 * scores each candidate on a *balanced* blend of CPV/sector fit, NUTS-tier
 * location proximity, and recency/deadline urgency (~equal thirds). Scores are
 * computed, not stored; the sort is fully deterministic per company snapshot so
 * offset pagination is stable within a snapshot.
 *
 * Reuses the CPV prefix-family semantics from `app/api/tenders/events/route.ts`
 * (a division such as `45` matches `45232421`, i.e. a whole CPV family).
 */
import type { NutsResolution } from "@/lib/tenders/nuts";

/** Opportunity statuses worth surfacing — awards/closed/cancelled are excluded. */
export const OPPORTUNITY_STATUSES = ["OPEN", "CLOSING_SOON", "UPCOMING"] as const;

/** Business categories that represent live buying opportunities. */
export const OPPORTUNITY_CATEGORIES = [
  "OPEN_OPPORTUNITY",
  "OPEN_OR_EARLY_COMPETITION",
  "UPCOMING_OPPORTUNITY",
] as const;

/** Balanced score weights (roughly equal thirds; exported for tuning). */
export const W_CPV = 0.34;
export const W_GEO = 0.33;
export const W_TIME = 0.33;

/** Ranking past a few hundred results is meaningless; this also bounds sort cost. */
export const RANK_CAP = 500;

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/** Decay time-constants (days) for the urgency/recency curves. */
const URGENCY_TAU_DAYS = 21;
const RECENCY_TAU_DAYS = 45;
const MS_PER_DAY = 86_400_000;

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
  geoScore: number;
  timeScore: number;
  hasCoordinates: boolean;
  sourceUrl: string | null;
}

/** Strip the CPV check digit and any non-digits: "45000000-7" → "45000000". */
export function stripCheckDigit(code: string): string {
  return code.split("-")[0].replace(/\D/g, "");
}

/**
 * Reduce a company's exact CPV codes to a minimal set of family prefixes.
 * Trailing zeros are trimmed so a division-level code ("45000000") broadens to
 * its whole family ("45") while a specific code ("45233120") stays narrow
 * ("4523312"). Prefixes subsumed by a shorter one are dropped, and every prefix
 * keeps at least 2 digits (a CPV division).
 */
export function toFamilyPrefixes(exactCodes: string[]): string[] {
  const trimmed = exactCodes
    .map((code) => {
      const stem = code.replace(/0+$/, "");
      return stem.length >= 2 ? stem : code.slice(0, 2);
    })
    .filter((p) => p.length >= 2);

  const unique = [...new Set(trimmed)].sort((a, b) => a.length - b.length);
  const minimal: string[] = [];
  for (const prefix of unique) {
    if (!minimal.some((kept) => prefix.startsWith(kept))) minimal.push(prefix);
  }
  return minimal;
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
}

export interface BuiltRelevanceQuery {
  pipeline: Record<string, unknown>[];
  exactCodes: string[];
  countries: string[];
}

/**
 * Builds the ranking aggregation pipeline (a single `$facet` returning `items`
 * + capped `total`). Caller runs it against `mongoDatabase.collection("tenders")`.
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

  // --- Candidate filter (index-backed) ---------------------------------------
  const recall: Record<string, unknown>[] = [];
  if (exactCodes.length) recall.push({ cpvCodes: { $in: exactCodes } });
  if (familyRegex) recall.push({ cpvCodes: { $regex: familyRegex } });
  if (nutsCodes.length) recall.push({ regions: { $in: nutsCodes } });

  const match: Record<string, unknown> = {
    isVisible: true,
    status: { $in: statuses },
    businessCategory: { $in: [...OPPORTUNITY_CATEGORIES] },
    countries: { $in: countries },
    $and: [
      { $or: [{ submissionDeadline: null }, { submissionDeadline: { $gte: opts.now } }] },
    ],
  };
  // Only apply the recall $or when we have at least one relevance signal;
  // otherwise (bare company profile) fall back to all national opportunities.
  if (recall.length) {
    (match.$and as Record<string, unknown>[]).push({ $or: recall });
  }
  if (opts.q && opts.q.trim()) {
    const rx = escapeRegex(opts.q.trim());
    (match.$and as Record<string, unknown>[]).push({
      $or: [
        { title: { $regex: rx, $options: "i" } },
        { description: { $regex: rx, $options: "i" } },
      ],
    });
  }

  // --- Score expressions -----------------------------------------------------
  const cpvScoreExpr = {
    $add: [
      {
        $multiply: [
          0.6,
          {
            $divide: [
              {
                $min: [
                  3,
                  { $size: { $setIntersection: ["$cpvCodes", exactCodes] } },
                ],
              },
              3,
            ],
          },
        ],
      },
      {
        $multiply: [
          0.4,
          familyRegex
            ? {
                $cond: [
                  {
                    $anyElementTrue: {
                      $map: {
                        input: "$cpvCodes",
                        as: "c",
                        in: { $regexMatch: { input: "$$c", regex: familyRegex } },
                      },
                    },
                  },
                  1,
                  0,
                ],
              }
            : 0,
        ],
      },
    ],
  };

  // Per-region NUTS tier, then the max across the tender's regions.
  const regionTierExpr = {
    $switch: {
      branches: [
        ...(inputs.nuts.nuts3
          ? [{ case: { $eq: ["$$r", inputs.nuts.nuts3] }, then: 1.0 }]
          : []),
        ...(inputs.nuts.nuts2
          ? [
              {
                case: { $eq: [{ $substrCP: ["$$r", 0, 4] }, inputs.nuts.nuts2] },
                then: 0.7,
              },
            ]
          : []),
        ...(inputs.nuts.nuts1
          ? [
              {
                case: { $eq: [{ $substrCP: ["$$r", 0, 3] }, inputs.nuts.nuts1] },
                then: 0.4,
              },
            ]
          : []),
        {
          case: { $eq: [{ $substrCP: ["$$r", 0, 2] }, inputs.nuts.country] },
          then: 0.15,
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
  const urgencyExpr = {
    $cond: [
      { $eq: [{ $ifNull: ["$submissionDeadline", null] }, null] },
      0,
      { $exp: { $multiply: [-1, { $divide: [{ $max: [0, daysToDeadline] }, URGENCY_TAU_DAYS] }] } },
    ],
  };
  const daysSincePub = {
    $divide: [{ $subtract: [opts.now, "$publicationDate"] }, MS_PER_DAY],
  };
  const recencyExpr = {
    $cond: [
      { $eq: [{ $ifNull: ["$publicationDate", null] }, null] },
      0,
      { $exp: { $multiply: [-1, { $divide: [{ $max: [0, daysSincePub] }, RECENCY_TAU_DAYS] }] } },
    ],
  };
  const timeScoreExpr = {
    $add: [{ $multiply: [0.5, urgencyExpr] }, { $multiply: [0.5, recencyExpr] }],
  };

  const rankCap = opts.rankCap ?? RANK_CAP;
  const skip = opts.page * opts.pageSize;

  const pipeline: Record<string, unknown>[] = [
    { $match: match },
    {
      $addFields: {
        cpvScore: cpvScoreExpr,
        geoScore: geoScoreExpr,
        timeScore: timeScoreExpr,
      },
    },
    {
      $addFields: {
        score: {
          $add: [
            { $multiply: [W_CPV, "$cpvScore"] },
            { $multiply: [W_GEO, "$geoScore"] },
            { $multiply: [W_TIME, "$timeScore"] },
          ],
        },
      },
    },
    ...(typeof opts.minScore === "number"
      ? [{ $match: { score: { $gte: opts.minScore } } }]
      : []),
    { $sort: { score: -1, submissionDeadline: 1, _id: 1 } },
    { $limit: rankCap },
    {
      $facet: {
        items: [
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
              geoScore: 1,
              timeScore: 1,
              hasCoordinates: {
                $cond: [{ $ifNull: ["$buyer.location", false] }, true, false],
              },
              sourceUrl: { $ifNull: [{ $arrayElemAt: ["$sourceLinks.url", 0] }, null] },
            },
          },
        ],
        total: [{ $count: "value" }],
      },
    },
  ];

  return { pipeline, exactCodes, countries };
}

/** Max markers a single `/geo` request will rank and attempt to geocode. */
export const MARKER_CAP = 60;

export interface GeoQueryOptions {
  now: Date;
  statuses?: string[];
  q?: string;
  minScore?: number;
  markerCap?: number;
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
 * Same candidate + scoring stages as the list, but capped to the top
 * `markerCap` and re-projected for the map. Reuses `buildRelevancePipeline`
 * and swaps its trailing `$facet` (list projection) for a marker projection,
 * so the ranking logic stays defined in exactly one place.
 */
export function buildGeoPipeline(
  inputs: RelevanceInputs,
  opts: GeoQueryOptions,
): { pipeline: Record<string, unknown>[]; exactCodes: string[]; countries: string[] } {
  const markerCap = opts.markerCap ?? MARKER_CAP;
  const { pipeline, exactCodes, countries } = buildRelevancePipeline(inputs, {
    now: opts.now,
    page: 0,
    pageSize: markerCap,
    statuses: opts.statuses,
    q: opts.q,
    minScore: opts.minScore,
    rankCap: markerCap,
  });
  // pipeline ends with [$match, $addFields×2, (minScore?), $sort, $limit, $facet].
  // Drop the $facet and project marker fields from the already-scored top set.
  const base = pipeline.slice(0, -1);
  base.push({
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
  });
  return { pipeline: base, exactCodes, countries };
}
