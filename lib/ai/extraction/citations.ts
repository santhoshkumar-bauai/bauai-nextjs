import { createHash } from "node:crypto";

import { z } from "zod";

/**
 * The citation contract (roadmap §6.1/§18.2, adapted to char-offset anchors).
 *
 * Two shapes exist on purpose:
 * - The MODEL-facing shape is minimal — a chunk id and a verbatim quote. We
 *   never ask the model for ids or offsets we can derive ourselves; every
 *   extra field is another thing it can hallucinate.
 * - The STORED shape is complete — verification (verify.ts) resolves the
 *   document, hashes the quote, and attaches the anchor.
 */

/** What the model must return per citation. */
export const modelCitationSchema = z.object({
  chunkId: z
    .string()
    .nullable()
    .describe("id of the [chunk:...] block the quote was copied from; null for document blocks"),
  quote: z
    .string()
    .min(1)
    .describe("verbatim quote from the source text, copied character-for-character"),
});
export type ModelCitation = z.infer<typeof modelCitationSchema>;

/**
 * Wraps a value type into the model-facing cited-value shape. Every field is
 * nullable end-to-end (§18.3): "not found" is a legal answer, and the model
 * must never invent a value to satisfy the JSON shape.
 */
export function citedValue<T extends z.ZodType>(value: T, description: string) {
  return z
    .object({
      value: value.nullable().describe(description),
      confidence: z.number().min(0).max(1),
      citations: z.array(modelCitationSchema),
    })
    .nullable();
}

export type ModelCitedValue<T> = {
  value: T | null;
  confidence: number;
  citations: ModelCitation[];
} | null;

/** Stored citation — everything verification could resolve. */
export interface StoredCitation {
  documentRecordId: string | null;
  fileSha256: string | null;
  chunkId: string | null;
  quote: string;
  /** sha256 of the whitespace-normalized quote. */
  quoteHash: string;
  anchor: {
    page: null;
    bbox: null;
    /** Chunk-granular offsets into the document text; null when unresolved. */
    charStart: number | null;
    charEnd: number | null;
  };
}

export type CitationState = "VERIFIED" | "UNVERIFIED" | "MISSING";

export interface StoredCitedValue<T = unknown> {
  value: T | null;
  confidence: number;
  citations: StoredCitation[];
  citationState: CitationState;
}

/**
 * Minimal chunk view the verification layer works with — built either from
 * retrieval hits or from ChunkDocument rows.
 */
export interface SourceChunk {
  chunkId: string;
  documentRecordId: string;
  fileSha256: string;
  text: string;
  sectionPath: string[];
  anchor: { charStart: number | null; charEnd: number | null };
}

/** Whitespace-insensitive comparison basis shared by verify + hashing. */
export function normalizeQuote(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function quoteHash(quote: string): string {
  return createHash("sha256").update(normalizeQuote(quote)).digest("hex");
}
