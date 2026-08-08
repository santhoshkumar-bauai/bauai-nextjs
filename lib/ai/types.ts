import type { ObjectId } from "mongodb";

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

/** One retrievable chunk of one tender document file (§12.4). */
export interface ChunkDocument extends EmbeddingMeta {
  _id?: ObjectId;
  /** null = shared tender corpus; ObjectId = tenant-owned (company upload). */
  tenantId: ObjectId | null;
  tenderId: ObjectId;
  /** `tender_documents._id` — a string of the form "canonicalKey#hash". */
  documentRecordId: string;
  fileSha256: string;
  fileName: string;
  mimeType: string | null;

  /** Document classification lands later; retrieval filters tolerate null. */
  docClass: string | null;
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
 * Durable ledger for document-derived work (chunking, chunk embedding).
 * `_id` is the idempotency key (§10.3), e.g.
 * `chunk:doc:{documentRecordId}:{fileSha256}:{chunkerVersion}`.
 */
export interface AiIndexStateDocument {
  _id: string;
  kind: "doc_chunks" | "chunk_embed";
  /** The tender_documents._id this state belongs to. */
  refId: string;
  sourceHash: string;
  status: AiIndexStatus;
  attempts: number;
  error: string | null;
  chunkCount: number | null;
  updatedAt: Date;
}
