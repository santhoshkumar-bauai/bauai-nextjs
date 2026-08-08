import {
  normalizeQuote,
  quoteHash,
  type ModelCitedValue,
  type SourceChunk,
  type StoredCitation,
  type StoredCitedValue,
} from "./citations.ts";

/**
 * Citation verification (roadmap §18.4, char-offset adaptation).
 *
 * A citation VERIFIES when its quote — whitespace-normalized — exists
 * verbatim in the claimed source:
 * - chunk path: inside the cited chunk's text; the stored anchor is the
 *   chunk's own offsets (chunk-granular: chunk text carries an overlap
 *   sentence not covered by its offsets, so intra-chunk positions would lie).
 * - document path (chunkId null): inside the document text; the enclosing
 *   chunk is resolved via the quote's position and the chunks' char offsets,
 *   so the stored citation still links to a chunk when one covers it.
 *
 * A value with no verified citation is UNVERIFIED; a null value is MISSING.
 */

export interface VerificationSources {
  chunksById: Map<string, SourceChunk>;
  /** Present on the document path. */
  documentText: string | null;
  documentRecordId: string | null;
  /** fileSha256 of the document, when known (document path). */
  documentFileSha256: string | null;
}

export function verifyCitation(
  citation: { chunkId: string | null; quote: string },
  sources: VerificationSources,
): { ok: boolean; stored: StoredCitation } {
  const normalizedQuote = normalizeQuote(citation.quote);
  const stored: StoredCitation = {
    documentRecordId: null,
    fileSha256: null,
    chunkId: citation.chunkId,
    quote: citation.quote,
    quoteHash: quoteHash(citation.quote),
    anchor: { page: null, bbox: null, charStart: null, charEnd: null },
  };

  if (normalizedQuote.length === 0) return { ok: false, stored };

  if (citation.chunkId != null) {
    const chunk = sources.chunksById.get(citation.chunkId);
    if (!chunk) return { ok: false, stored };
    const found = normalizeQuote(chunk.text).includes(normalizedQuote);
    if (!found) return { ok: false, stored };
    stored.documentRecordId = chunk.documentRecordId;
    stored.fileSha256 = chunk.fileSha256;
    stored.anchor = {
      page: null,
      bbox: null,
      charStart: chunk.anchor.charStart,
      charEnd: chunk.anchor.charEnd,
    };
    return { ok: true, stored };
  }

  // Document path: locate the quote in the RAW text so char offsets are
  // meaningful for enclosing-chunk resolution. Whitespace differences between
  // quote and document are bridged by a flexible-whitespace regex.
  if (sources.documentText == null) return { ok: false, stored };

  const flexible = normalizedQuote
    .split(" ")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  let match: RegExpMatchArray | null = null;
  try {
    match = sources.documentText.match(new RegExp(flexible));
  } catch {
    match = null;
  }
  if (!match || match.index == null) return { ok: false, stored };

  const start = match.index;
  const end = start + match[0].length;
  stored.documentRecordId = sources.documentRecordId;
  stored.fileSha256 = sources.documentFileSha256;

  // Resolve the enclosing chunk by offset containment.
  for (const chunk of sources.chunksById.values()) {
    const { charStart, charEnd } = chunk.anchor;
    if (charStart == null || charEnd == null) continue;
    if (start >= charStart && start < charEnd) {
      stored.chunkId = chunk.chunkId;
      stored.anchor = { page: null, bbox: null, charStart, charEnd };
      return { ok: true, stored };
    }
  }

  // Quote verified against the document but spans no single chunk (e.g. a
  // chunk-boundary straddle): keep exact document offsets, chunkId stays null.
  stored.anchor = { page: null, bbox: null, charStart: start, charEnd: end };
  return { ok: true, stored };
}

export interface VerifiedFieldsResult {
  fields: Record<string, StoredCitedValue>;
  /** Field names whose value is non-null but no citation verified. */
  failedFieldNames: string[];
}

export function verifyFields(
  rawFields: Record<string, ModelCitedValue<unknown>>,
  sources: VerificationSources,
): VerifiedFieldsResult {
  const fields: Record<string, StoredCitedValue> = {};
  const failedFieldNames: string[] = [];

  for (const [name, raw] of Object.entries(rawFields)) {
    if (raw == null || raw.value == null) {
      fields[name] = {
        value: null,
        confidence: 0,
        citations: [],
        citationState: "MISSING",
      };
      continue;
    }

    const verified: StoredCitation[] = [];
    const unverified: StoredCitation[] = [];
    for (const citation of raw.citations) {
      const result = verifyCitation(citation, sources);
      (result.ok ? verified : unverified).push(result.stored);
    }

    const ok = verified.length > 0;
    fields[name] = {
      value: raw.value,
      confidence: raw.confidence,
      // Keep failed citations too — the review UI will want to show them.
      citations: [...verified, ...unverified],
      citationState: ok ? "VERIFIED" : "UNVERIFIED",
    };
    if (!ok) failedFieldNames.push(name);
  }

  return { fields, failedFieldNames };
}
