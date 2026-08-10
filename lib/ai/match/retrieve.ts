import type { ObjectId } from "mongodb";

import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { searchIndexNames } from "../db/search-indexes.ts";
import type { CompanyMatchProfileDocument } from "../types.ts";

/**
 * Semantic candidate retrieval: one `$vectorSearch` per company facet against
 * the notice vector index, run in parallel. Generalizes `searchNotices` in
 * `lib/ai/retrieval/hybrid.ts` to multiple query vectors and returns per-facet
 * ranked lists for the fusion stage rather than a single merged list.
 */

/** Statuses a company can still bid on. Mirrors OPPORTUNITY_STATUSES. */
const CANDIDATE_STATUSES = ["OPEN", "CLOSING_SOON", "UPCOMING"];
const CANDIDATE_CATEGORIES = [
  "OPEN_OPPORTUNITY",
  "OPEN_OR_EARLY_COMPETITION",
  "UPCOMING_OPPORTUNITY",
];

export interface FacetHits {
  key: string;
  kind: "profile" | "document";
  label: string | null;
  weight: number;
  /** Tender ids in rank order, best first. */
  ids: string[];
  /** tenderId hex → raw cosine from $meta:"vectorSearchScore". */
  scores: Map<string, number>;
}

export interface RetrieveOptions {
  /** Extra hard filters the user set in the toolbar, applied at the ANN stage
   * so the pool is spent on tenders they can actually see. */
  contractNatures?: string[];
  countries?: string[];
}

function buildFilter(
  profile: CompanyMatchProfileDocument,
  options: RetrieveOptions,
): Record<string, unknown> {
  const countries =
    options.countries?.length ? options.countries : profile.scope.countries;

  const conditions: Record<string, unknown>[] = [
    // A coarse pre-filter only. `filters.status` is a snapshot taken when the
    // notice was embedded and can lag `tenders.status`, so everything here is
    // re-verified against the joined tender document during scoring.
    { "filters.status": { $in: CANDIDATE_STATUSES } },
    { "filters.businessCategory": { $in: CANDIDATE_CATEGORIES } },
  ];
  if (countries.length) {
    conditions.push({ "filters.countryCodes": { $in: countries } });
  }
  if (options.contractNatures?.length) {
    conditions.push({ "filters.contractNature": { $in: options.contractNatures } });
  }

  // Deliberately NO `filters.submissionDeadline` clause. An Atlas range filter
  // drops documents where the field is null, and 42% of tenders have no
  // deadline — filtering here would silently delete ~11k live tenders from
  // every company's feed. The `deadline null OR >= now` rule is applied in the
  // scoring aggregation against `tenders` instead.
  return { $and: conditions };
}

/**
 * Run every facet's ANN query. Facets with an empty vector (a profile written
 * before its embeddings landed) are skipped rather than sent as a zero vector,
 * which would return an arbitrary neighbourhood.
 */
export async function retrieveByFacets(
  profile: CompanyMatchProfileDocument,
  options: RetrieveOptions = {},
): Promise<FacetHits[]> {
  const env = aiEnv();
  const { tenderSearchDocuments } = await getAiCollections();
  const filter = buildFilter(profile, options);

  const usable = profile.facets.filter(
    (facet) => facet.embedding.length === profile.embeddingDimensions,
  );
  if (usable.length === 0) return [];

  return Promise.all(
    usable.map(async (facet): Promise<FacetHits> => {
      const rows = await tenderSearchDocuments
        .aggregate<{ tenderId: ObjectId; score: number }>(
          [
            {
              $vectorSearch: {
                index: searchIndexNames.noticeVectors,
                path: "embedding",
                queryVector: facet.embedding,
                numCandidates: env.matchNumCandidates,
                limit: env.matchCandidatesPerFacet,
                filter,
              },
            },
            { $project: { tenderId: 1, score: { $meta: "vectorSearchScore" } } },
          ],
          // Mandatory: $vectorSearch rejects the shared client's default
          // majority read concern.
          { readConcern: { level: "local" } },
        )
        .toArray();

      const scores = new Map<string, number>();
      const ids: string[] = [];
      for (const row of rows) {
        const id = row.tenderId.toHexString();
        ids.push(id);
        scores.set(id, row.score);
      }

      return {
        key: facet.key,
        kind: facet.kind,
        label: facet.label,
        weight: facet.weight,
        ids,
        scores,
      };
    }),
  );
}

/**
 * Whether a thrown error means "this deployment has no Atlas Search". Plain
 * Community mongod rejects `$vectorSearch` as an unrecognized stage, and the
 * tenders page must degrade to the classic feed rather than 500.
 */
export function isSearchUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Unrecognized pipeline stage|SearchNotEnabled|\$vectorSearch|index not found|no such command|CommandNotSupported/i.test(
    message,
  );
}
