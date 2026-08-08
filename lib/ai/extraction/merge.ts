import type { StoredCitedValue } from "./citations.ts";

/**
 * Field-level merge of verified extraction results from multiple paths
 * (retrieval + per-document). Pure.
 *
 * Precedence per field: VERIFIED beats UNVERIFIED beats MISSING; within the
 * same state the higher confidence wins. Citations of the winning value are
 * kept plus any citations from other results whose value agrees exactly
 * (JSON-equal) — corroboration is signal for the review UI later.
 */

export type VerifiedFields = Record<string, StoredCitedValue>;

export interface MergedExtraction {
  fields: VerifiedFields;
  unresolved: string[];
}

const STATE_RANK = { VERIFIED: 2, UNVERIFIED: 1, MISSING: 0 } as const;

function betterOf(a: StoredCitedValue, b: StoredCitedValue): StoredCitedValue {
  const stateDelta = STATE_RANK[a.citationState] - STATE_RANK[b.citationState];
  if (stateDelta !== 0) return stateDelta > 0 ? a : b;
  return b.confidence > a.confidence ? b : a;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function mergeFieldResults(
  fieldNames: string[],
  results: VerifiedFields[],
): MergedExtraction {
  const fields: VerifiedFields = {};
  const unresolved: string[] = [];

  for (const name of fieldNames) {
    const candidates = results
      .map((result) => result[name])
      .filter((value): value is StoredCitedValue => value != null);

    if (candidates.length === 0) {
      fields[name] = {
        value: null,
        confidence: 0,
        citations: [],
        citationState: "MISSING",
      };
      unresolved.push(name);
      continue;
    }

    let winner = candidates[0];
    for (const candidate of candidates.slice(1)) {
      winner = betterOf(winner, candidate);
    }

    // Corroborating citations from agreeing results, deduped.
    const seen = new Set(
      winner.citations.map((c) => `${c.quoteHash}:${c.chunkId ?? ""}`),
    );
    const citations = [...winner.citations];
    for (const candidate of candidates) {
      if (candidate === winner || !sameValue(candidate.value, winner.value)) continue;
      for (const citation of candidate.citations) {
        const key = `${citation.quoteHash}:${citation.chunkId ?? ""}`;
        if (!seen.has(key)) {
          seen.add(key);
          citations.push(citation);
        }
      }
    }

    fields[name] = { ...winner, citations };
    if (fields[name].value == null) unresolved.push(name);
  }

  return { fields, unresolved };
}
