import { ObjectId } from "mongodb";

import { getAiCollections } from "../db/collections.ts";
import { keywordSearchChunks, keywordSearchCompanyChunks } from "./keyword.ts";
import { fuseRanks } from "./rrf.ts";
import { getReranker } from "./rerank.ts";
import type {
  CompanyCorpusFilters,
  RetrievalQuery,
  RetrievedChunk,
} from "./types.ts";
import { CANDIDATES_PER_ARM } from "./types.ts";
import { vectorSearchChunks, vectorSearchCompanyChunks } from "./vector.ts";

/**
 * The §17.3 pipeline: legal-ref-aware keyword search and vector search run in
 * parallel (40 candidates each), reciprocal-rank fusion merges them, the
 * reranker slot trims to the final top k (8–12 typical).
 */
export async function hybridRetrieveChunks(
  query: RetrievalQuery,
): Promise<RetrievedChunk[]> {
  const useKeyword = query.mode !== "vector";
  const useVector = query.mode !== "keyword";

  const [keywordHits, vectorHits] = await Promise.all([
    useKeyword
      ? keywordSearchChunks(query.text, query.filters, CANDIDATES_PER_ARM)
      : Promise.resolve([]),
    useVector
      ? vectorSearchChunks(query.text, query.filters, CANDIDATES_PER_ARM)
      : Promise.resolve([]),
  ]);

  const fused = fuseRanks([
    { ids: keywordHits.map((hit) => hit.id) },
    { ids: vectorHits.map((hit) => hit.id) },
  ]);

  const keywordScores = new Map(keywordHits.map((hit) => [hit.id, hit.score]));
  const vectorScores = new Map(vectorHits.map((hit) => [hit.id, hit.score]));

  // Fetch the chunk bodies for the fusion survivors (cap: 40 before rerank).
  const shortlist = fused.slice(0, CANDIDATES_PER_ARM);
  const { chunks } = await getAiCollections();
  const rows = await chunks
    .find({ _id: { $in: shortlist.map((entry) => new ObjectId(entry.id)) } })
    .toArray();
  const rowsById = new Map(rows.map((row) => [String(row._id), row]));

  const candidates: RetrievedChunk[] = [];
  for (const [rank, entry] of shortlist.entries()) {
    const row = rowsById.get(entry.id);
    if (!row?._id) continue;
    candidates.push({
      chunkId: row._id,
      tenderId: row.tenderId,
      documentRecordId: row.documentRecordId,
      fileSha256: row.fileSha256,
      fileName: row.fileName,
      sectionPath: row.sectionPath,
      text: row.text,
      legalRefs: row.legalRefs,
      anchor: row.anchor,
      scores: {
        keyword: keywordScores.get(entry.id),
        vector: vectorScores.get(entry.id),
        fused: entry.score,
      },
      rank,
    });
  }

  const reranked = await getReranker().rerank(query.text, candidates, query.k);
  return reranked.map((chunk, index) => ({ ...chunk, rank: index }));
}

/**
 * Hybrid retrieval over a company's own document corpus (tenant-scoped
 * chunks). Used as evidence for the fit analysis. Same §17.3 pipeline shape
 * as tender retrieval, but through the strict CompanyCorpusFilters arms.
 */
export async function hybridRetrieveCompanyChunks(input: {
  text: string;
  filters: CompanyCorpusFilters;
  k: number;
}): Promise<RetrievedChunk[]> {
  const [keywordHits, vectorHits] = await Promise.all([
    keywordSearchCompanyChunks(input.text, input.filters, CANDIDATES_PER_ARM),
    vectorSearchCompanyChunks(input.text, input.filters, CANDIDATES_PER_ARM),
  ]);

  const fused = fuseRanks([
    { ids: keywordHits.map((hit) => hit.id) },
    { ids: vectorHits.map((hit) => hit.id) },
  ]);
  const keywordScores = new Map(keywordHits.map((hit) => [hit.id, hit.score]));
  const vectorScores = new Map(vectorHits.map((hit) => [hit.id, hit.score]));

  const shortlist = fused.slice(0, CANDIDATES_PER_ARM);
  const { chunks } = await getAiCollections();
  const rows = await chunks
    .find({
      _id: { $in: shortlist.map((entry) => new ObjectId(entry.id)) },
      // Belt-and-braces: even a bug in the search filters cannot cross the
      // tenant boundary past this fetch filter.
      tenantId: input.filters.tenantId,
    })
    .toArray();
  const rowsById = new Map(rows.map((row) => [String(row._id), row]));

  const candidates: RetrievedChunk[] = [];
  for (const [rank, entry] of shortlist.entries()) {
    const row = rowsById.get(entry.id);
    if (!row?._id) continue;
    candidates.push({
      chunkId: row._id,
      tenderId: row.tenderId,
      documentRecordId: row.documentRecordId,
      fileSha256: row.fileSha256,
      fileName: row.fileName,
      sectionPath: row.sectionPath,
      text: row.text,
      legalRefs: row.legalRefs,
      anchor: row.anchor,
      scores: {
        keyword: keywordScores.get(entry.id),
        vector: vectorScores.get(entry.id),
        fused: entry.score,
      },
      rank,
    });
  }

  const reranked = await getReranker().rerank(input.text, candidates, input.k);
  return reranked.map((chunk, index) => ({ ...chunk, rank: index }));
}

/**
 * Notice-level vector search over `tender_search_documents` (Clara's funnel
 * entry point later; useful for "find tenders like X" immediately). Returns
 * tenderIds with similarity scores; callers join to `tenders` themselves.
 */
export async function searchNotices(input: {
  text: string;
  limit: number;
  filters?: {
    status?: string;
    cpvCodes?: string[];
    countryCodes?: string[];
    contractNature?: string;
  };
}): Promise<Array<{ tenderId: ObjectId; score: number }>> {
  const { getGateway } = await import("../gateway/index.ts");
  const { searchIndexNames } = await import("../db/search-indexes.ts");
  const { tenderSearchDocuments } = await getAiCollections();

  const embedded = await getGateway().embed({
    texts: [input.text],
    taskType: "RETRIEVAL_QUERY",
  });

  const conditions: Record<string, unknown>[] = [];
  if (input.filters?.status) {
    conditions.push({ "filters.status": { $eq: input.filters.status } });
  }
  if (input.filters?.cpvCodes?.length) {
    conditions.push({ "filters.cpvCodes": { $in: input.filters.cpvCodes } });
  }
  if (input.filters?.countryCodes?.length) {
    conditions.push({ "filters.countryCodes": { $in: input.filters.countryCodes } });
  }
  if (input.filters?.contractNature) {
    conditions.push({ "filters.contractNature": { $eq: input.filters.contractNature } });
  }

  const rows = await tenderSearchDocuments
    .aggregate<{ tenderId: ObjectId; score: number }>([
      {
        $vectorSearch: {
          index: searchIndexNames.noticeVectors,
          path: "embedding",
          queryVector: embedded.vectors[0],
          numCandidates: Math.max(input.limit * 20, 200),
          limit: input.limit,
          ...(conditions.length ? { filter: { $and: conditions } } : {}),
        },
      },
      { $project: { tenderId: 1, score: { $meta: "vectorSearchScore" } } },
    ], { readConcern: { level: "local" } })
    .toArray();

  return rows;
}
