import type { Document } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import { searchIndexNames } from "../db/search-indexes.ts";
import { getGateway } from "../gateway/index.ts";
import type { CompanyCorpusFilters, RetrievalFilters } from "./types.ts";

/**
 * Vector arm: embed the query with the RETRIEVAL_QUERY task hint (asymmetric
 * to the documents' RETRIEVAL_DOCUMENT) and run `$vectorSearch` with the
 * §17.4 pre-filters.
 */

export interface VectorHit {
  id: string;
  score: number;
}

function vectorFilter(filters: RetrievalFilters): Document {
  const conditions: Document[] = [
    { tenderId: { $eq: filters.tenderId } },
    {
      $or: [
        { tenantId: { $eq: null } },
        ...(filters.tenantId ? [{ tenantId: { $eq: filters.tenantId } }] : []),
      ],
    },
  ];
  if (filters.documentRecordId) {
    conditions.push({ documentRecordId: { $eq: filters.documentRecordId } });
  }
  if (filters.docClass) conditions.push({ docClass: { $eq: filters.docClass } });
  if (filters.language) conditions.push({ language: { $eq: filters.language } });
  return { $and: conditions };
}

/**
 * Company-corpus vector filter: exactly one tenantId equality, NO null
 * branch, NO tenderId clause. Exported for the tenant-safety unit test.
 */
export function companyVectorFilter(filters: CompanyCorpusFilters): Document {
  const conditions: Document[] = [{ tenantId: { $eq: filters.tenantId } }];
  if (filters.documentRecordId) {
    conditions.push({ documentRecordId: { $eq: filters.documentRecordId } });
  }
  return { $and: conditions };
}

export async function vectorSearchCompanyChunks(
  queryText: string,
  filters: CompanyCorpusFilters,
  limit: number,
): Promise<VectorHit[]> {
  const { chunks } = await getAiCollections();

  const embedded = await getGateway().embed({
    texts: [queryText],
    taskType: "RETRIEVAL_QUERY",
  });

  const rows = await chunks
    .aggregate<{ _id: unknown; score: number }>(
      [
        {
          $vectorSearch: {
            index: searchIndexNames.chunkVectors,
            path: "embedding",
            queryVector: embedded.vectors[0],
            numCandidates: Math.max(limit * 20, 200),
            limit,
            filter: companyVectorFilter(filters),
          },
        },
        { $project: { _id: 1, score: { $meta: "vectorSearchScore" } } },
      ],
      { readConcern: { level: "local" } },
    )
    .toArray();
  return rows.map((row) => ({ id: String(row._id), score: row.score }));
}

export async function vectorSearchChunks(
  queryText: string,
  filters: RetrievalFilters,
  limit: number,
): Promise<VectorHit[]> {
  const { chunks } = await getAiCollections();

  const embedded = await getGateway().embed({
    texts: [queryText],
    taskType: "RETRIEVAL_QUERY",
  });

  const pipeline: Document[] = [
    {
      $vectorSearch: {
        index: searchIndexNames.chunkVectors,
        path: "embedding",
        queryVector: embedded.vectors[0],
        numCandidates: Math.max(limit * 20, 200),
        limit,
        filter: vectorFilter(filters),
      },
    },
    { $project: { _id: 1, score: { $meta: "vectorSearchScore" } } },
  ];

  // $vectorSearch rejects the client-default majority readConcern.
  const rows = await chunks
    .aggregate<{ _id: unknown; score: number }>(pipeline, {
      readConcern: { level: "local" },
    })
    .toArray();
  return rows.map((row) => ({ id: String(row._id), score: row.score }));
}
