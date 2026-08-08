import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * Runtime validation for AI persistence shapes and queue payloads. The TS
 * interfaces in `lib/ai/types.ts` are the compile-time contract; these schemas
 * are parsed at the trust boundaries — queue producers/consumers and writes —
 * so a malformed job or document fails loudly instead of poisoning an index.
 */

export const objectIdSchema = z.instanceof(ObjectId);

/** Hex-string form used inside queue payloads (jobs serialize to JSON). */
export const objectIdHexSchema = z
  .string()
  .refine((v) => ObjectId.isValid(v), "not a valid ObjectId hex string");

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i, "not a sha256 hex digest");

export const embeddingMetaSchema = z.object({
  embeddingModel: z.string().min(1),
  embeddingVersion: z.string().min(1),
  embeddingDimensions: z.number().int().positive(),
  sourceHash: sha256Schema,
});

export const tenderSearchDocumentSchema = embeddingMetaSchema.extend({
  _id: objectIdSchema.optional(),
  tenderId: objectIdSchema,
  canonicalKey: z.string().min(1),
  language: z.string().nullable(),
  text: z.string().min(1),
  filters: z.object({
    status: z.string(),
    businessCategory: z.string().nullable(),
    cpvCodes: z.array(z.string()),
    countryCodes: z.array(z.string()),
    regionCodes: z.array(z.string()),
    procedureType: z.string().nullable(),
    contractNature: z.string().nullable(),
    estimatedValueAmount: z.number().nullable(),
    submissionDeadline: z.date().nullable(),
  }),
  embedding: z.array(z.number()),
  indexedAt: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const chunkAnchorSchema = z.object({
  page: z.number().int().nullable(),
  paragraph: z.number().int().nullable(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  charStart: z.number().int().min(0),
  charEnd: z.number().int().min(0),
});

export const chunkSchema = embeddingMetaSchema.extend({
  _id: objectIdSchema.optional(),
  tenantId: objectIdSchema.nullable(),
  tenderId: objectIdSchema,
  documentRecordId: z.string().min(1),
  fileSha256: sha256Schema,
  fileName: z.string(),
  mimeType: z.string().nullable(),
  docClass: z.string().nullable(),
  language: z.string().nullable(),
  sectionPath: z.array(z.string()),
  chunkIndex: z.number().int().min(0),
  text: z.string().min(1),
  legalRefs: z.array(z.string()),
  anchor: chunkAnchorSchema,
  tokenCount: z.number().int().positive(),
  chunkerVersion: z.string().min(1),
  embedding: z.array(z.number()),
  createdAt: z.date(),
});

export const aiIndexStateSchema = z.object({
  _id: z.string().min(1),
  kind: z.enum([
    "doc_chunks",
    "chunk_embed",
    "doc_class",
    "extract_schema",
    "company_doc_embed",
  ]),
  refId: z.string().min(1),
  sourceHash: z.string(),
  status: z.enum(["PENDING", "RUNNING", "DONE", "FAILED"]),
  attempts: z.number().int().min(0),
  error: z.string().nullable(),
  chunkCount: z.number().int().nullable(),
  updatedAt: z.date(),
});

/**
 * Common job envelope (roadmap §10.2). `tenantId` is null for work on the
 * global tender corpus; when present it MUST have been derived from
 * authenticated server context by the producer, never from client input.
 * `actorId` is "system" for sweep-produced jobs.
 */
export const baseAIJobSchema = z.object({
  tenantId: objectIdHexSchema.nullable(),
  actorId: z.string().min(1),
  runId: z.string().min(1),
  tenderId: objectIdHexSchema.optional(),
  documentId: z.string().optional(),
  packageId: z.string().optional(),
  schemaVersion: z.number().int().positive(),
  attempt: z.number().int().min(0),
  correlationId: z.string().min(1),
});

export type BaseAIJob = z.infer<typeof baseAIJobSchema>;
