import type { Document } from "mongodb";

import { extractLegalRefs } from "../chunking/legal-refs.ts";
import { getAiCollections } from "../db/collections.ts";
import { searchIndexNames } from "../db/search-indexes.ts";
import type { RetrievalFilters } from "./types.ts";

/**
 * Keyword arm: Atlas `$search` over the german-analyzed chunk text. When the
 * query itself contains a legal reference, an exact `legalRefs` term clause
 * is added with a strong boost — embeddings and stemming both blur "§ 13"
 * vs "§ 14", the token index does not (§16.2).
 */

export interface KeywordHit {
  id: string;
  score: number;
}

function filterClauses(filters: RetrievalFilters): Document[] {
  const clauses: Document[] = [
    { equals: { path: "tenderId", value: filters.tenderId } },
    // Shared corpus (null) OR the caller's own tenant material.
    {
      compound: {
        should: [
          { equals: { path: "tenantId", value: null } },
          ...(filters.tenantId
            ? [{ equals: { path: "tenantId", value: filters.tenantId } }]
            : []),
        ],
        minimumShouldMatch: 1,
      },
    },
  ];
  if (filters.documentRecordId) {
    clauses.push({
      equals: { path: "documentRecordId", value: filters.documentRecordId },
    });
  }
  if (filters.docClass) {
    clauses.push({ equals: { path: "docClass", value: filters.docClass } });
  }
  if (filters.language) {
    clauses.push({ equals: { path: "language", value: filters.language } });
  }
  return clauses;
}

export async function keywordSearchChunks(
  queryText: string,
  filters: RetrievalFilters,
  limit: number,
): Promise<KeywordHit[]> {
  const { chunks } = await getAiCollections();
  const legalRefs = extractLegalRefs(queryText);

  const should: Document[] = [
    { text: { query: queryText, path: "text" } },
    ...legalRefs.map((ref) => ({
      term: {
        query: ref,
        path: "legalRefs",
        score: { boost: { value: 5 } },
      },
    })),
  ];

  const pipeline: Document[] = [
    {
      $search: {
        index: searchIndexNames.chunkText,
        compound: {
          should,
          minimumShouldMatch: 1,
          filter: filterClauses(filters),
        },
      },
    },
    { $limit: limit },
    { $project: { _id: 1, score: { $meta: "searchScore" } } },
  ];

  // $search rejects the client-default majority readConcern.
  const rows = await chunks
    .aggregate<{ _id: unknown; score: number }>(pipeline, {
      readConcern: { level: "local" },
    })
    .toArray();
  return rows.map((row) => ({ id: String(row._id), score: row.score }));
}
