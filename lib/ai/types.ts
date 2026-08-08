import type { ObjectId } from "mongodb";

import type { DocClass } from "./classification/doc-classes.ts";

/**
 * Persistence shapes for the AI subsystem (roadmap §12, adapted).
 *
 * Tenancy rule: tender-derived data is global reference data (§6.3) — one
 * shared embedding corpus for all companies. Company-derived and agent-produced
 * data carries a `tenantId` (the `Company._id`). `chunks.tenantId` is `null`
 * for the shared corpus so tenant-owned chunks can join the same indexes later,
 * and every retrieval query constrains `tenantId ∈ {null, currentTenant}`.
 */

/** Identity stamped onto every stored vector (§17.1). */
export interface EmbeddingMeta {
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;
  /** sha256 of the exact text that was embedded; staleness detector. */
  sourceHash: string;
}

/** Curated searchable representation of one tender notice (§12.2). */
export interface TenderSearchDocument extends EmbeddingMeta {
  _id?: ObjectId;
  tenderId: ObjectId;
  canonicalKey: string;
  language: string | null;

  /** Curated text ("Title: ...\nBuyer: ..."), never raw JSON (§17.2). */
  text: string;

  /** Pre-filters for $vectorSearch; mirrors the tender aggregate. */
  filters: {
    status: string;
    businessCategory: string | null;
    cpvCodes: string[];
    countryCodes: string[];
    regionCodes: string[];
    procedureType: string | null;
    contractNature: string | null;
    estimatedValueAmount: number | null;
    submissionDeadline: Date | null;
  };

  embedding: number[];
  indexedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Positional anchor (§12.4). Page/paragraph/bbox arrive with the Python
 * document worker; char offsets are exact against the extracted flat text. */
export interface ChunkAnchor {
  page: number | null;
  paragraph: number | null;
  bbox: [number, number, number, number] | null;
  charStart: number;
  charEnd: number;
}

/** One retrievable chunk of one tender document file (§12.4) — or, when
 * `tenantId` is set and `tenderId` is null, of a company document. */
export interface ChunkDocument extends EmbeddingMeta {
  _id?: ObjectId;
  /** null = shared tender corpus; ObjectId = tenant-owned (company upload). */
  tenantId: ObjectId | null;
  /** null for company-corpus chunks. */
  tenderId: ObjectId | null;
  /** `tender_documents._id` ("canonicalKey#hash") or "company:{fileId}". */
  documentRecordId: string;
  fileSha256: string;
  fileName: string;
  mimeType: string | null;

  /** Stamped by the classifier after chunking; null until classified. */
  docClass: DocClass | null;
  language: string | null;
  sectionPath: string[];
  chunkIndex: number;

  text: string;
  /** Normalised legal references ("§ 13 VOB/B"), exact-match indexed (§16.2). */
  legalRefs: string[];
  anchor: ChunkAnchor;
  tokenCount: number;
  chunkerVersion: string;

  embedding: number[];
  createdAt: Date;
}

/** Work-ledger statuses shared by AI indexing states. */
export type AiIndexStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

/**
 * Per-file classification record (roadmap §15.3/§15.4). Corrections later
 * feed evaluation data, so the method and rule that produced each decision
 * are kept.
 */
export interface DocumentClassificationDocument {
  /** "{documentRecordId}#{fileSha256}" — one classification per file. */
  _id: string;
  tenderId: ObjectId;
  documentRecordId: string;
  fileSha256: string;
  fileName: string;
  docClass: DocClass;
  confidence: number;
  method: "heuristic" | "llm";
  /** Heuristic rule name, or the model id for LLM classifications. */
  source: string;
  classifierVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One extraction record per (tenderId, schemaName) — roadmap §12.5 adapted:
 * merged across the tender's documents, replaced wholesale on re-extraction.
 * `corpusHash` identifies the document corpus the record was computed from;
 * a new fetched document changes it and re-enables extraction.
 */
export interface ExtractionDocument {
  _id?: ObjectId;
  /** Tender-derived shared data — global by convention. */
  tenantId: null;
  tenderId: ObjectId;
  schemaName: string;
  schemaVersion: number;
  model: {
    provider: string;
    providerModel: string;
    promptVersion: string;
    temperature: number;
  };
  corpusHash: string;
  sourceDocumentRecordIds: string[];
  /** Field name → StoredCitedValue (lib/ai/extraction/citations.ts). */
  fields: Record<string, unknown>;
  unresolved: string[];
  status: "VERIFIED" | "PARTIAL" | "EMPTY" | "FAILED";
  stats: {
    modelCalls: number;
    retriedFields: number;
    verifiedFields: number;
    totalFields: number;
  };
  extractedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tender-centric AI overview (about / scope / buyer / risks / highlights),
 * generated in BOTH languages with one call — the UI picks by locale.
 * Tender-derived → global. Works from the notice alone; document excerpts
 * enrich it when they exist (`sourceChunkCount` > 0).
 */
export interface TenderOverviewDocument {
  _id?: ObjectId;
  tenantId: null;
  tenderId: ObjectId;
  /** { en: {about, scope, buyer, risks[], highlights[]}, de: {...} } */
  overview: Record<string, unknown>;
  sourceChunkCount: number;
  /** Chunk-corpus identity used, or null for notice-only generations. */
  corpusHash: string | null;
  model: { provider: string; providerModel: string; promptVersion: string };
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cached company-fit recommendation, tenant-scoped: the assessment depends on
 * the company's own data, so it is private to the tenant and keyed by a
 * `companyDataHash` — when company data changes the stored hash no longer
 * matches and the UI shows the cached result as stale.
 */
export interface TenderFitRecommendationDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  tenderId: ObjectId;
  companyDataHash: string;
  locale: "en" | "de";
  /** TenderRecommendation shape from lib/tenders/recommendation.ts. */
  recommendation: Record<string, unknown>;
  model: { provider: string; providerModel: string; promptVersion: string };
  /** Extraction corpus identity used for the facts section, if any. */
  corpusHash: string | null;
  retrievedChunkIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Durable ledger for document-derived work (chunking, chunk embedding,
 * classification, extraction). `_id` is the idempotency key (§10.3), e.g.
 * `chunk:doc:{documentRecordId}:{fileSha256}:{chunkerVersion}`.
 */
export interface AiIndexStateDocument {
  _id: string;
  kind:
    | "doc_chunks"
    | "chunk_embed"
    | "doc_class"
    | "extract_schema"
    | "company_doc_embed";
  /** The tender_documents._id this state belongs to. */
  refId: string;
  sourceHash: string;
  status: AiIndexStatus;
  attempts: number;
  error: string | null;
  chunkCount: number | null;
  updatedAt: Date;
}
