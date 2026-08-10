import { fuseRanks, type RankedList } from "../retrieval/rrf.ts";
import type { FacetHits } from "./retrieve.ts";

/**
 * Combines the semantic arms with the deterministic CPV/geo/time ranking.
 *
 * Pure module — no I/O — so the weighting is unit-testable, which matters
 * because these constants are the entire behaviour of the feature.
 */

/**
 * The deterministic arm carries the heaviest single weight on purpose. It buys
 * a safety property: AI mode can never be dramatically worse than the classic
 * feed at the head of the list, and a company with one thin facet degrades
 * toward classic ordering rather than toward noise.
 */
export const W_RULE_ARM = 1.2;

/**
 * Cosine from `$meta:"vectorSearchScore"` lands in a very compressed band, so
 * the raw value is useless as a displayed "match %". These map the useful part
 * of the band onto 0..1.
 *
 * MEASURED, not guessed. Over the returned ANN results for a seeded company
 * against the 44.8k-tender corpus (gemini-embedding-001 @ 1536d): min 0.813,
 * p10 0.816, p50 0.828, p90 0.871, p99 0.887, max 0.895. The floor sits at
 * roughly p10 — "the weakest hit worth returning scores about zero" — and the
 * ceiling near p99. Note this is a truncated distribution: anything the ANN
 * did not return is below the floor by construction.
 *
 * Re-measure and reset these after any embedding model or version change:
 *   db.tender_match_scores.find({"signals.semanticRaw": {$gt: 0}})
 * and take the percentiles of `signals.semanticRaw`.
 */
export const SEM_FLOOR = 0.81;
export const SEM_CEIL = 0.89;

export function normalizeSemantic(score: number): number {
  const scaled = (score - SEM_FLOOR) / (SEM_CEIL - SEM_FLOOR);
  return Math.min(1, Math.max(0, scaled));
}

/**
 * Geo and time enter as multipliers rather than as further RRF arms because
 * they are constraints, not relevance signals: a perfect capability match on
 * the far side of the country is still a worse opportunity, but it is not
 * irrelevant. The floors keep a strong semantic hit from being annihilated by
 * a company that has only a country-level region on file.
 */
export const GEO_FLOOR = 0.35;
export const TIME_FLOOR = 0.5;

export function geoFactor(geoScore: number): number {
  return GEO_FLOOR + (1 - GEO_FLOOR) * clamp01(geoScore);
}

export function timeFactor(timeScore: number): number {
  return TIME_FLOOR + (1 - TIME_FLOOR) * clamp01(timeScore);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export interface FusedCandidate {
  tenderId: string;
  /** Weighted RRF total across every arm. */
  fused: number;
  /** Best raw cosine across the facets that retrieved this tender. */
  semanticRaw: number;
  /** `semanticRaw` mapped out of the compressed cosine band. */
  semantic: number;
  matchedFacets: Array<{
    key: string;
    kind: "profile" | "document";
    label: string | null;
    score: number;
  }>;
}

/**
 * Fuse the per-facet ANN lists with the deterministic ranking into one
 * candidate list, capped at `poolCap`.
 *
 * `ruleRankedIds` is the classic feed's ordering for this company. Passing it
 * as an arm — rather than blending its 0..1 score numerically — is what avoids
 * having to calibrate cosine against `cpvScore` at all.
 */
export function fuseCandidates(input: {
  facetHits: FacetHits[];
  ruleRankedIds: string[];
  poolCap: number;
}): FusedCandidate[] {
  const { facetHits, ruleRankedIds, poolCap } = input;

  const lists: RankedList[] = [
    ...facetHits.map((facet) => ({ ids: facet.ids, weight: facet.weight })),
    { ids: ruleRankedIds, weight: W_RULE_ARM },
  ];

  const fused = fuseRanks(lists);

  return fused.slice(0, poolCap).map((entry) => {
    const matchedFacets = facetHits
      .filter((facet) => facet.scores.has(entry.id))
      .map((facet) => ({
        key: facet.key,
        kind: facet.kind,
        label: facet.label,
        score: facet.scores.get(entry.id) ?? 0,
      }))
      .sort((a, b) => b.score - a.score);

    const semanticRaw = matchedFacets.length > 0 ? matchedFacets[0].score : 0;

    return {
      tenderId: entry.id,
      fused: entry.score,
      semanticRaw,
      semantic: matchedFacets.length > 0 ? normalizeSemantic(semanticRaw) : 0,
      // Only the facets that actually retrieved it, best first — this is the
      // "matched via …" line on the card.
      matchedFacets: matchedFacets.slice(0, 3),
    };
  });
}

/**
 * The pre-judge score, 0..1. `fused` is normalized against the strongest
 * candidate in this pool rather than an absolute scale — RRF totals depend on
 * how many arms ran, so they are only meaningful relative to each other.
 */
export function matchScore(input: {
  fused: number;
  maxFused: number;
  geoScore: number;
  timeScore: number;
}): number {
  const fused01 = input.maxFused > 0 ? input.fused / input.maxFused : 0;
  return clamp01(fused01) * geoFactor(input.geoScore) * timeFactor(input.timeScore);
}

/**
 * What the feed sorts on. The LLM's judgement is weighted slightly above the
 * retrieval blend: retrieval is good at "is this the same kind of work", the
 * judge is the only stage that can see "they want a certified asbestos handler
 * and you are not one".
 *
 * An unjudged tender keeps its retrieval score unchanged rather than being
 * pushed down — a failed judge batch must not silently bury real matches.
 */
export const W_MATCH = 0.45;
export const W_FIT = 0.55;

export function finalScore(match: number, fitScore: number | null): number {
  if (fitScore == null) return clamp01(match);
  return clamp01(W_MATCH * match + W_FIT * (fitScore / 100));
}
