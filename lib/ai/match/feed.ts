import type { ObjectId } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import type { TenderFilters, TenderSort } from "../../tenders/filters.ts";
import { reorderStages, type RankedTenderRaw } from "../../tenders/relevance.ts";
import type { TenderMatchScoreDocument } from "../types.ts";

/**
 * Reads the persisted AI match rows and joins them to live tender documents.
 *
 * The join is not decoration: `tender_match_scores` is a snapshot, and between
 * two refreshes a tender can be cancelled, awarded, or pass its deadline. The
 * post-join `$match` re-applies exactly the visibility rules the classic feed
 * uses, so a stale row can never surface a tender the company cannot bid on.
 */

const MS_PER_DAY = 86_400_000;

const OPPORTUNITY_STATUSES = ["OPEN", "CLOSING_SOON", "UPCOMING"];

export interface MatchFeedQuery {
  tenantId: ObjectId;
  /** Rows from this run only — the atomic-swap pin. */
  runId: ObjectId;
  filters: TenderFilters;
  page: number;
  pageSize: number;
  now: Date;
  excludeIds: ObjectId[];
}

/** The subset of a match row the feed projects alongside the tender. */
export type MatchAnnotationRaw = Pick<
  TenderMatchScoreDocument,
  | "matchScore"
  | "fitScore"
  | "finalScore"
  | "confidence"
  | "signals"
  | "matchedFacets"
  | "reasons"
  | "matchedCapabilities"
  | "concerns"
  | "computedAt"
>;

export interface MatchFeedRow extends RankedTenderRaw {
  match: MatchAnnotationRaw;
}

/**
 * `nearest` needs the `geo_cache` `$lookup` and the company's coordinates,
 * neither of which this pipeline carries — the distance hints are resolved
 * afterwards, per page. Falling back to relevance keeps a bookmarked
 * `?sort=nearest` URL working instead of erroring on it.
 */
function feedSort(sort: TenderSort | undefined): TenderSort | undefined {
  return sort === "nearest" ? undefined : sort;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Hard filters applied after the join. Mirrors `buildRelevancePipeline`'s
 * `$match` — deliberately, so the two feeds hide the same things.
 */
function tenderConditions(
  filters: TenderFilters,
  now: Date,
): Record<string, unknown>[] {
  const statuses = filters.statuses.length ? filters.statuses : OPPORTUNITY_STATUSES;
  const conditions: Record<string, unknown>[] = [
    { "tender.isVisible": true },
    { "tender.status": { $in: statuses } },
    {
      $or: [
        { "tender.submissionDeadline": null },
        { "tender.submissionDeadline": { $gte: now } },
      ],
    },
  ];

  if (filters.contractNatures.length) {
    conditions.push({ "tender.contractNature": { $in: filters.contractNatures } });
  }
  if (filters.sectors.length) {
    const safe = filters.sectors.filter((s) => /^[0-9]{2}$/.test(s));
    if (safe.length) {
      conditions.push({ "tender.cpvCodes": { $regex: `^(${safe.join("|")})` } });
    }
  }
  if (filters.regions.length) {
    const safe = filters.regions.filter((r) => /^DE[0-9A-Z]{0,2}$/.test(r));
    if (safe.length) {
      conditions.push({ "tender.regions": { $regex: `^(${safe.join("|")})` } });
    }
  }
  if (filters.deadlineInDays) {
    const cutoff = new Date(now.getTime() + filters.deadlineInDays * MS_PER_DAY);
    conditions.push({
      "tender.submissionDeadline": { $gte: now, $lte: cutoff },
    });
  }
  if (filters.q?.trim()) {
    const rx = escapeRegex(filters.q.trim());
    conditions.push({
      $or: [
        { "tender.title": { $regex: rx, $options: "i" } },
        { "tender.description": { $regex: rx, $options: "i" } },
      ],
    });
  }
  return conditions;
}

/**
 * Build the feed aggregation. Runs on `tender_match_scores`, which holds at
 * most `matchRankCap` rows per company — so the sort is index-backed and the
 * whole thing stays cheap regardless of corpus size.
 */
export function buildMatchFeedPipeline(query: MatchFeedQuery): Record<string, unknown>[] {
  const match: Record<string, unknown> = {
    tenantId: query.tenantId,
    runId: query.runId,
  };
  if (typeof query.filters.minScore === "number" && query.filters.minScore > 0) {
    match.finalScore = { $gte: query.filters.minScore };
  }
  if (query.excludeIds.length) {
    match.tenderId = { $nin: query.excludeIds };
  }

  return [
    { $match: match },
    // ix_tenant_run_score; `_id` tiebreak keeps offset paging stable.
    { $sort: { finalScore: -1, _id: 1 } },
    {
      $lookup: {
        from: "tenders",
        localField: "tenderId",
        foreignField: "_id",
        as: "tender",
      },
    },
    { $unwind: "$tender" },
    { $match: { $and: tenderConditions(query.filters, query.now) } },
    {
      $facet: {
        items: [
          // Project the tender to the top level first so `reorderStages` — the
          // very same sort stages the classic feed uses — sees the field names
          // it expects, and "sort by deadline" means the same thing in both.
          {
            $addFields: {
              "tender.match": {
                matchScore: "$matchScore",
                fitScore: "$fitScore",
                finalScore: "$finalScore",
                confidence: "$confidence",
                signals: "$signals",
                matchedFacets: "$matchedFacets",
                reasons: "$reasons",
                matchedCapabilities: "$matchedCapabilities",
                concerns: "$concerns",
                computedAt: "$computedAt",
              },
            },
          },
          { $replaceRoot: { newRoot: "$tender" } },
          { $addFields: { score: "$match.matchScore" } },
          ...reorderStages(feedSort(query.filters.sort), null),
          { $skip: query.page * query.pageSize },
          { $limit: query.pageSize },
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
              cpvScore: "$match.signals.cpv",
              // Rows persisted before the text arm existed have no `text`
              // signal; 0 keeps `RankedTenderRaw.textScore` honest either way.
              textScore: { $ifNull: ["$match.signals.text", 0] },
              geoScore: "$match.signals.geo",
              timeScore: "$match.signals.time",
              hasCoordinates: {
                $cond: [{ $ifNull: ["$buyer.location", false] }, true, false],
              },
              location: "$buyer.location",
              procedureType: 1,
              contractNature: 1,
              sourceUrl: { $ifNull: [{ $arrayElemAt: ["$sourceLinks.url", 0] }, null] },
              match: 1,
            },
          },
        ],
        total: [{ $count: "value" }],
      },
    },
  ];
}

export async function runMatchFeed(query: MatchFeedQuery): Promise<{
  rows: MatchFeedRow[];
  total: number;
}> {
  const { tenderMatchScores } = await getAiCollections();
  const [facet] = await tenderMatchScores
    .aggregate<{ items: MatchFeedRow[]; total: { value: number }[] }>(
      buildMatchFeedPipeline(query),
    )
    .toArray();

  return { rows: facet?.items ?? [], total: facet?.total?.[0]?.value ?? 0 };
}
