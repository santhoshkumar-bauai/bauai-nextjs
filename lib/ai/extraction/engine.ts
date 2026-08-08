import type { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import type { TenderDocumentRecord } from "../../ingestion/documents/types.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { getGateway } from "../gateway/index.ts";
import type { ModelGateway } from "../gateway/types.ts";
import { hybridRetrieveChunks } from "../retrieval/hybrid.ts";
import type { ChunkDocument } from "../types.ts";
import type { ModelCitedValue, SourceChunk } from "./citations.ts";
import { buildExtractionPrompt, type SourceBlock } from "./prompts.ts";
import { SCHEMA_QUERIES } from "./queries.ts";
import type { ExtractionSchemaEntry } from "./schemas/index.ts";
import { loadFileText } from "./source-text.ts";

const log = logger.child("ai.extraction.engine");

/** Raw model output for one extraction call, plus its verification sources. */
export interface RawExtractionResult {
  path: "retrieval" | "document";
  /** null for the retrieval path (sources span documents). */
  documentRecordId: string | null;
  fields: Record<string, ModelCitedValue<unknown>>;
  unresolved: string[];
  /** chunkId → source chunk, for quote verification. */
  chunksById: Map<string, SourceChunk>;
  /** Full document text for the document path, for quote verification. */
  documentText: string | null;
  /** The blocks sent — reused verbatim by the retry pass. */
  blocks: SourceBlock[];
  modelCalls: number;
}

interface ModelOutput {
  fields: Record<string, ModelCitedValue<unknown>>;
  unresolved: string[];
}

function chunkRowToSource(row: ChunkDocument): SourceChunk {
  return {
    chunkId: String(row._id),
    documentRecordId: row.documentRecordId,
    fileSha256: row.fileSha256,
    text: row.text,
    sectionPath: row.sectionPath,
    anchor: { charStart: row.anchor.charStart, charEnd: row.anchor.charEnd },
  };
}

const RETRIEVAL_K_PER_QUERY = 8;

/**
 * Retrieval-targeted path: schema-specific queries → hybrid retrieval across
 * the tender → one structured call over the merged top chunks.
 */
export async function extractViaRetrieval(input: {
  tenderId: ObjectId;
  schema: ExtractionSchemaEntry;
  gateway?: ModelGateway;
}): Promise<RawExtractionResult | null> {
  const env = aiEnv();
  const gateway = input.gateway ?? getGateway();

  const byChunkId = new Map<string, { source: SourceChunk; bestRank: number }>();
  for (const query of SCHEMA_QUERIES[input.schema.name]) {
    const hits = await hybridRetrieveChunks({
      text: query,
      mode: "hybrid",
      k: RETRIEVAL_K_PER_QUERY,
      filters: { tenantId: null, tenderId: input.tenderId },
    });
    for (const hit of hits) {
      const id = String(hit.chunkId);
      const existing = byChunkId.get(id);
      if (!existing || hit.rank < existing.bestRank) {
        byChunkId.set(id, {
          source: {
            chunkId: id,
            documentRecordId: hit.documentRecordId,
            fileSha256: hit.fileSha256,
            text: hit.text,
            sectionPath: hit.sectionPath,
            anchor: {
              charStart: hit.anchor.charStart,
              charEnd: hit.anchor.charEnd,
            },
          },
          bestRank: hit.rank,
        });
      }
    }
  }

  if (byChunkId.size === 0) return null;

  const selected = [...byChunkId.values()]
    .sort((a, b) => a.bestRank - b.bestRank)
    .slice(0, env.extractionMaxChunks)
    .map((entry) => entry.source);

  const blocks: SourceBlock[] = selected.map((source) => ({
    kind: "chunk",
    chunkId: source.chunkId,
    sectionPath: source.sectionPath,
    text: source.text,
  }));

  const output = await callModel(gateway, input.schema, blocks);
  return {
    path: "retrieval",
    documentRecordId: null,
    fields: output.fields,
    unresolved: output.unresolved,
    chunksById: new Map(selected.map((source) => [source.chunkId, source])),
    documentText: null,
    blocks,
    modelCalls: 1,
  };
}

/** Document classes whose full text goes through per-document extraction. */
const FULL_DOC_CLASSES = ["conditions_of_participation", "contract_conditions"] as const;

/**
 * Large packages can classify dozens of files as conditions/contract docs
 * (BVB/ZVB annex sprawl); one model call per doc per schema explodes cost.
 * The retrieval path already covers the long tail, so the full-doc path
 * reads only the highest-confidence, most substantive few.
 */
const MAX_FULL_DOCS = 3;

/**
 * Full-document path (§18.3: one document per extraction call) for the two
 * classes that concentrate most schema answers.
 */
export async function extractFromDocuments(input: {
  tenderId: ObjectId;
  schema: ExtractionSchemaEntry;
  gateway?: ModelGateway;
}): Promise<RawExtractionResult[]> {
  const env = aiEnv();
  const gateway = input.gateway ?? getGateway();
  const { documentClassifications, chunks } = await getAiCollections();
  const db = await getIngestionDb();
  const records = db.collection<TenderDocumentRecord>("tender_documents");

  const classified = (
    await documentClassifications
      .find({
        tenderId: input.tenderId,
        docClass: { $in: [...FULL_DOC_CLASSES] },
      })
      .sort({ confidence: -1 })
      .toArray()
  ).slice(0, MAX_FULL_DOCS);

  const results: RawExtractionResult[] = [];
  for (const classification of classified) {
    const record = await records.findOne({ _id: classification.documentRecordId });
    const file = record?.files.find((f) => f.sha256 === classification.fileSha256);
    if (!record || !file) continue;

    let text = await loadFileText(file);
    if (text.length === 0) continue;
    if (text.length > env.extractionMaxDocChars) {
      log.warn("document truncated for extraction", {
        documentRecordId: classification.documentRecordId,
        fileName: file.fileName,
        chars: text.length,
        cap: env.extractionMaxDocChars,
      });
      text = text.slice(0, env.extractionMaxDocChars);
    }

    const blocks: SourceBlock[] = [
      {
        kind: "document",
        documentRecordId: classification.documentRecordId,
        fileName: file.fileName,
        text,
      },
    ];
    const output = await callModel(gateway, input.schema, blocks);

    // The file's chunks let verification resolve quotes to enclosing chunks.
    const fileChunks = await chunks
      .find({
        documentRecordId: classification.documentRecordId,
        fileSha256: classification.fileSha256,
      })
      .toArray();

    results.push({
      path: "document",
      documentRecordId: classification.documentRecordId,
      fields: output.fields,
      unresolved: output.unresolved,
      chunksById: new Map(
        fileChunks.map((row) => [String(row._id), chunkRowToSource(row)]),
      ),
      documentText: text,
      blocks,
      modelCalls: 1,
    });
  }

  return results;
}

export async function callModel(
  gateway: ModelGateway,
  schema: ExtractionSchemaEntry,
  blocks: SourceBlock[],
  promptOverride?: string,
): Promise<ModelOutput> {
  const result = await gateway.generateStructured({
    role: "extraction",
    prompt: promptOverride ?? buildExtractionPrompt({ schema, blocks }),
    temperature: 0,
    schema: schema.jsonSchema,
    zod: schema.zod as never,
  });
  return result.value as ModelOutput;
}
