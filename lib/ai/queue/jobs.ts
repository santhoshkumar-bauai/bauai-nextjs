import { z } from "zod";

import { objectIdHexSchema, sha256Schema } from "../schemas/index.ts";

/**
 * Queue payloads and their idempotency keys (§10.3). The key doubles as the
 * BullMQ `jobId` — a queued duplicate is dropped by BullMQ itself — and
 * processors re-check identity (sourceHash + model + version) at write time so
 * replays after completion are safe no-ops.
 *
 * Payloads carry only ids and version identities, never document content:
 * Redis is transport, MongoDB is the source of truth.
 */

/** Work on the global tender corpus runs as the system actor. */
const systemActor = z.string().min(1).default("system");

export const noticeEmbedJobSchema = z.object({
  kind: z.literal("notice_embed"),
  tenderId: objectIdHexSchema,
  embeddingModel: z.string().min(1),
  embeddingVersion: z.string().min(1),
  actorId: systemActor,
  correlationId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
});
export type NoticeEmbedJob = z.infer<typeof noticeEmbedJobSchema>;

export const docChunkJobSchema = z.object({
  kind: z.literal("doc_chunks"),
  /** `tender_documents._id` — string of the form "canonicalKey#hash". */
  documentRecordId: z.string().min(1),
  tenderId: objectIdHexSchema,
  fileSha256: sha256Schema,
  chunkerVersion: z.string().min(1),
  actorId: systemActor,
  correlationId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
});
export type DocChunkJob = z.infer<typeof docChunkJobSchema>;

export const chunkEmbedJobSchema = z.object({
  kind: z.literal("chunk_embed"),
  documentRecordId: z.string().min(1),
  tenderId: objectIdHexSchema,
  fileSha256: sha256Schema,
  chunkerVersion: z.string().min(1),
  embeddingModel: z.string().min(1),
  embeddingVersion: z.string().min(1),
  actorId: systemActor,
  correlationId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
});
export type ChunkEmbedJob = z.infer<typeof chunkEmbedJobSchema>;

export const companyDocEmbedJobSchema = z.object({
  kind: z.literal("company_doc_embed"),
  companyFileId: objectIdHexSchema,
  /** Company._id — MUST be derived from server context by the producer (§10.2). */
  tenantId: objectIdHexSchema,
  chunkerVersion: z.string().min(1),
  embeddingModel: z.string().min(1),
  embeddingVersion: z.string().min(1),
  actorId: systemActor,
  correlationId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
});
export type CompanyDocEmbedJob = z.infer<typeof companyDocEmbedJobSchema>;

export function companyDocEmbedJobId(
  job: Pick<CompanyDocEmbedJob, "companyFileId">,
): string {
  // Content-level idempotency lives in the ai_index_state ledger (the byte
  // sha is unknown at enqueue time); per-file dedupe is enough for the queue.
  return `company-embed:${job.companyFileId}`;
}

export const extractSchemaJobSchema = z.object({
  kind: z.literal("extract_schema"),
  tenderId: objectIdHexSchema,
  schemaName: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  promptVersion: z.string().min(1),
  /** Identity of the tender's chunked corpus at enqueue time. */
  corpusHash: sha256Schema,
  actorId: systemActor,
  correlationId: z.string().min(1),
  attempt: z.number().int().min(0).default(0),
});
export type ExtractSchemaJob = z.infer<typeof extractSchemaJobSchema>;

export type AiJob =
  | NoticeEmbedJob
  | DocChunkJob
  | ChunkEmbedJob
  | ExtractSchemaJob
  | CompanyDocEmbedJob;

export const aiJobSchema = z.discriminatedUnion("kind", [
  noticeEmbedJobSchema,
  docChunkJobSchema,
  chunkEmbedJobSchema,
  extractSchemaJobSchema,
  companyDocEmbedJobSchema,
]);

export function noticeEmbedJobId(job: Pick<NoticeEmbedJob, "tenderId" | "embeddingModel" | "embeddingVersion">): string {
  return `embed:notice:${job.tenderId}:${job.embeddingModel}:${job.embeddingVersion}`;
}

export function docChunkJobId(job: Pick<DocChunkJob, "documentRecordId" | "fileSha256" | "chunkerVersion">): string {
  return `chunk:doc:${job.documentRecordId}:${job.fileSha256}:${job.chunkerVersion}`;
}

export function extractSchemaJobId(
  job: Pick<
    ExtractSchemaJob,
    "tenderId" | "schemaName" | "schemaVersion" | "promptVersion" | "corpusHash"
  >,
): string {
  return `extract:${job.tenderId}:${job.schemaName}:${job.schemaVersion}:${job.promptVersion}:${job.corpusHash.slice(0, 16)}`;
}

export function chunkEmbedJobId(
  job: Pick<
    ChunkEmbedJob,
    "documentRecordId" | "fileSha256" | "chunkerVersion" | "embeddingModel" | "embeddingVersion"
  >,
): string {
  return `embed:chunks:${job.documentRecordId}:${job.fileSha256}:${job.chunkerVersion}:${job.embeddingModel}:${job.embeddingVersion}`;
}
