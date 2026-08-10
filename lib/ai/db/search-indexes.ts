import type { Collection, Document } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "./collections.ts";

/**
 * Atlas Search and Vector Search index definitions (§17). These require an
 * Atlas deployment or the mongodb-atlas-local dev image; plain Community
 * mongod rejects `createSearchIndexes`, which `ensureAiSearchIndexes` reports
 * as a clear error instead of a stack trace.
 */

export const searchIndexNames = {
  noticeVectors: "vx_tender_search_documents",
  chunkVectors: "vx_chunks",
  chunkText: "sx_chunks",
  tenderText: "sx_tenders",
} as const;

interface SearchIndexSpec {
  name: string;
  type: "search" | "vectorSearch";
  definition: Document;
}

function noticeVectorSpec(dimensions: number): SearchIndexSpec {
  return {
    name: searchIndexNames.noticeVectors,
    type: "vectorSearch",
    definition: {
      fields: [
        {
          type: "vector",
          path: "embedding",
          numDimensions: dimensions,
          similarity: "cosine",
        },
        { type: "filter", path: "language" },
        { type: "filter", path: "filters.status" },
        { type: "filter", path: "filters.businessCategory" },
        { type: "filter", path: "filters.cpvCodes" },
        { type: "filter", path: "filters.countryCodes" },
        { type: "filter", path: "filters.regionCodes" },
        { type: "filter", path: "filters.procedureType" },
        { type: "filter", path: "filters.contractNature" },
        { type: "filter", path: "filters.submissionDeadline" },
      ],
    },
  };
}

/** Filter set from roadmap §17.4: tenant, tender, document, class, language, refs. */
function chunkVectorSpec(dimensions: number): SearchIndexSpec {
  return {
    name: searchIndexNames.chunkVectors,
    type: "vectorSearch",
    definition: {
      fields: [
        {
          type: "vector",
          path: "embedding",
          numDimensions: dimensions,
          similarity: "cosine",
        },
        { type: "filter", path: "tenantId" },
        { type: "filter", path: "tenderId" },
        { type: "filter", path: "documentRecordId" },
        { type: "filter", path: "docClass" },
        { type: "filter", path: "language" },
        { type: "filter", path: "legalRefs" },
      ],
    },
  };
}

const chunkTextSpec: SearchIndexSpec = {
  name: searchIndexNames.chunkText,
  type: "search",
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        // German analyzer: stemming plus decompounding-friendly matching, so
        // "Eignungsnachweise" matches "Nachweis der Eignung" far better than
        // the standard analyzer would.
        text: { type: "string", analyzer: "lucene.german" },
        // Exact-match legal references; embeddings cannot reliably tell
        // "§ 13" from "§ 14" (§16.2), so these stay keyword-indexed.
        legalRefs: { type: "token" },
        tenderId: { type: "objectId" },
        tenantId: { type: "objectId" },
        documentRecordId: { type: "token" },
        docClass: { type: "token" },
        language: { type: "token" },
      },
    },
  },
};

/**
 * Full-text index over the notice's own words, on `tenders` itself.
 *
 * This is the cold-start arm: a company that has signed up and uploaded
 * nothing has no embeddings, so the only thing left to match on is what the
 * notice says. CPV cannot carry that job — 14% of open tenders carry no CPV
 * code at all, and the ones that do are frequently filed under a division that
 * has little to do with the actual scope. The words in the title and the lot
 * descriptions are what the buyer actually wrote.
 *
 * Both analyzers are indexed per field. `lucene.german` does the stemming and
 * decompounding that makes "Elektroinstallationsarbeiten" reachable from
 * "Elektroinstallation"; the `standard` multi keeps the 17% of the corpus that
 * is not German (TED publishes in every member-state language) searchable at
 * all. Queries hit both and take the better hit.
 */
const tenderTextSpec: SearchIndexSpec = {
  name: searchIndexNames.tenderText,
  type: "search",
  definition: {
    mappings: {
      dynamic: false,
      fields: {
        title: {
          type: "string",
          analyzer: "lucene.german",
          multi: { std: { type: "string", analyzer: "lucene.standard" } },
        },
        description: {
          type: "string",
          analyzer: "lucene.german",
          multi: { std: { type: "string", analyzer: "lucene.standard" } },
        },
        lots: {
          type: "document",
          fields: {
            title: {
              type: "string",
              analyzer: "lucene.german",
              multi: { std: { type: "string", analyzer: "lucene.standard" } },
            },
            description: {
              type: "string",
              analyzer: "lucene.german",
              multi: { std: { type: "string", analyzer: "lucene.standard" } },
            },
          },
        },
        // Filters, so the lexical arm can be narrowed to biddable work in the
        // company's country before scoring rather than after.
        isVisible: { type: "boolean" },
        status: { type: "token" },
        businessCategory: { type: "token" },
        countries: { type: "token" },
        regions: { type: "token" },
        contractNature: { type: "token" },
        submissionDeadline: { type: "date" },
      },
    },
  },
};

async function listSearchIndexes(
  collection: Collection<Document>,
): Promise<Map<string, { status?: string; queryable?: boolean }>> {
  const rows = (await collection.listSearchIndexes().toArray()) as Array<{
    name: string;
    status?: string;
    queryable?: boolean;
  }>;
  return new Map(rows.map((r) => [r.name, r]));
}

async function ensureIndex(
  collection: Collection<Document>,
  spec: SearchIndexSpec,
  log: (message: string) => void,
): Promise<void> {
  const existing = await listSearchIndexes(collection);
  if (!existing.has(spec.name)) {
    log(`creating search index ${spec.name} on ${collection.collectionName}`);
    await collection.createSearchIndex({
      name: spec.name,
      type: spec.type,
      definition: spec.definition,
    });
  }
}

async function waitQueryable(
  collection: Collection<Document>,
  names: string[],
  log: (message: string) => void,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const indexes = await listSearchIndexes(collection);
    const pending = names.filter((n) => !indexes.get(n)?.queryable);
    if (pending.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `search indexes not queryable after ${timeoutMs}ms: ${pending.join(", ")}`,
      );
    }
    log(`waiting for search indexes: ${pending.join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

export interface EnsureSearchIndexOptions {
  log?: (message: string) => void;
  /** Initial builds on 44k embedded docs can take a while. */
  timeoutMs?: number;
}

export async function ensureAiSearchIndexes(
  options: EnsureSearchIndexOptions = {},
): Promise<void> {
  const log = options.log ?? (() => {});
  const timeoutMs = options.timeoutMs ?? 300_000;
  const dimensions = aiEnv().embeddingDimensions;
  const c = await getAiCollections();

  const notices = c.tenderSearchDocuments as unknown as Collection<Document>;
  const chunks = c.chunks as unknown as Collection<Document>;
  const tenders = (await getIngestionDb()).collection("tenders");

  try {
    await ensureIndex(notices, noticeVectorSpec(dimensions), log);
    await ensureIndex(chunks, chunkVectorSpec(dimensions), log);
    await ensureIndex(chunks, chunkTextSpec, log);
    await ensureIndex(tenders, tenderTextSpec, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/SearchNotEnabled|Unrecognized pipeline stage|no such command|CommandNotSupported/i.test(message)) {
      throw new Error(
        "This MongoDB deployment does not support Atlas Search indexes. " +
          "Use Atlas or the mongodb/mongodb-atlas-local dev image (docker/docker-compose.yml).",
      );
    }
    throw error;
  }

  await waitQueryable(
    notices,
    [searchIndexNames.noticeVectors],
    log,
    timeoutMs,
  );
  await waitQueryable(
    chunks,
    [searchIndexNames.chunkVectors, searchIndexNames.chunkText],
    log,
    timeoutMs,
  );
  await waitQueryable(tenders, [searchIndexNames.tenderText], log, timeoutMs);
}
