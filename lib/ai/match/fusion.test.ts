import { describe, expect, it } from "vitest";

import {
  finalScore,
  fuseCandidates,
  geoFactor,
  GEO_FLOOR,
  matchScore,
  normalizeSemantic,
  SEM_CEIL,
  SEM_FLOOR,
  timeFactor,
  TIME_FLOOR,
  W_RULE_ARM,
  W_TEXT_ARM,
} from "./fusion.ts";
import type { FacetHits } from "./retrieve.ts";

const facet = (
  key: string,
  ids: string[],
  weight = 1,
  kind: "profile" | "document" = "profile",
): FacetHits => ({
  key,
  kind,
  label: null,
  weight,
  ids,
  scores: new Map(ids.map((id, index) => [id, 0.9 - index * 0.05])),
});

describe("normalizeSemantic", () => {
  it("maps the useful cosine band onto 0..1", () => {
    expect(normalizeSemantic(SEM_FLOOR)).toBe(0);
    expect(normalizeSemantic(SEM_CEIL)).toBe(1);
    expect(normalizeSemantic((SEM_FLOOR + SEM_CEIL) / 2)).toBeCloseTo(0.5, 10);
  });

  it("clamps outside the band instead of going negative or past 1", () => {
    expect(normalizeSemantic(0.1)).toBe(0);
    expect(normalizeSemantic(0.99)).toBe(1);
  });
});

describe("geo and time factors", () => {
  it("never annihilates a match, however far away or late", () => {
    // A great capability match in the wrong state is worse, not irrelevant.
    expect(geoFactor(0)).toBe(GEO_FLOOR);
    expect(timeFactor(0)).toBe(TIME_FLOOR);
  });

  it("reaches 1 for a perfect constraint score", () => {
    expect(geoFactor(1)).toBeCloseTo(1, 10);
    expect(timeFactor(1)).toBeCloseTo(1, 10);
  });

  it("treats non-finite input as the worst case rather than propagating NaN", () => {
    expect(geoFactor(Number.NaN)).toBe(GEO_FLOOR);
  });
});

describe("fuseCandidates", () => {
  it("ranks a tender found by several facets above a single-facet hit", () => {
    const fused = fuseCandidates({
      facetHits: [facet("capabilities", ["a", "b"]), facet("reference:0", ["a", "c"])],
      ruleRankedIds: [],
      poolCap: 10,
    });
    expect(fused[0].tenderId).toBe("a");
  });

  it("surfaces tenders the deterministic ranking never returned", () => {
    // This is the entire point of the feature: the rule arm cannot see "z",
    // because its CPV and NUTS both miss, but a facet retrieved it.
    const fused = fuseCandidates({
      facetHits: [facet("capabilities", ["z"])],
      ruleRankedIds: ["p", "q"],
      poolCap: 10,
    });
    expect(fused.map((entry) => entry.tenderId)).toContain("z");
  });

  it("lets the deterministic arm dominate a single weak facet", () => {
    // The safety property: a degraded profile decays toward the classic
    // ordering rather than toward whatever one thin vector retrieved. The
    // rule arm is no longer the heaviest arm overall (that inverted into
    // CPV-driven noise), but it still outweighs the weakest facets.
    const fused = fuseCandidates({
      facetHits: [facet("capabilities", ["weak"], 0.35)],
      ruleRankedIds: ["strong"],
      poolCap: 10,
    });
    expect(W_RULE_ARM).toBeGreaterThan(0.35);
    expect(fused[0].tenderId).toBe("strong");
  });

  it("keeps the services-first arms heavier than the rule arm combined", () => {
    // The point of the reweighting: capabilities (1.0) + text (0.9) must be
    // able to outvote the CPV/geo rule arm, because CPV is the least
    // trustworthy input in the system.
    expect(1.0 + W_TEXT_ARM).toBeGreaterThan(2 * W_RULE_ARM);
    expect(W_TEXT_ARM).toBeLessThan(1.0);
  });

  it("lets the text arm surface a tender no other arm returned", () => {
    // A tender with missing or wrong CPV codes is invisible to the rule arm
    // and may be missed by ANN — the words in the notice are its only way in.
    const fused = fuseCandidates({
      facetHits: [facet("capabilities", ["a"])],
      ruleRankedIds: ["b"],
      textRankedIds: ["nocpv", "a"],
      poolCap: 10,
    });
    expect(fused.map((entry) => entry.tenderId)).toContain("nocpv");
    // "a" is now voted for by two arms and must outrank both single-arm hits.
    expect(fused[0].tenderId).toBe("a");
  });

  it("is unchanged when the text arm is empty", () => {
    const base = {
      facetHits: [facet("capabilities", ["a", "b"])],
      ruleRankedIds: ["b", "c"],
      poolCap: 10,
    };
    const without = fuseCandidates(base);
    const withEmpty = fuseCandidates({ ...base, textRankedIds: [] });
    expect(withEmpty).toEqual(without);
  });

  it("honors runtime weight overrides", () => {
    // The env rollback path: text arm zeroed, rule arm restored to 1.2 must
    // reproduce the pre-text-arm ordering exactly.
    const base = {
      facetHits: [facet("capabilities", ["a"], 0.35)],
      ruleRankedIds: ["b"],
      poolCap: 10,
    };
    const legacy = fuseCandidates({
      ...base,
      textRankedIds: ["a"],
      weights: { ruleArm: 1.2, textArm: 0 },
    });
    const reference = fuseCandidates({
      ...base,
      weights: { ruleArm: 1.2 },
    });
    expect(legacy).toEqual(reference);
    expect(legacy[0].tenderId).toBe("b");
  });

  it("records which facets retrieved a tender, best first", () => {
    const hits = [
      facet("capabilities", ["x"]),
      { ...facet("doc:1", ["x"], 0.5, "document"), scores: new Map([["x", 0.95]]) },
    ];
    const [candidate] = fuseCandidates({
      facetHits: hits,
      ruleRankedIds: [],
      poolCap: 10,
    });
    expect(candidate.matchedFacets[0].key).toBe("doc:1");
    expect(candidate.semanticRaw).toBeCloseTo(0.95, 10);
  });

  it("reports zero semantic signal for a rule-only candidate", () => {
    const [candidate] = fuseCandidates({
      facetHits: [],
      ruleRankedIds: ["only"],
      poolCap: 10,
    });
    expect(candidate.semantic).toBe(0);
    expect(candidate.matchedFacets).toEqual([]);
  });

  it("caps the pool", () => {
    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const fused = fuseCandidates({
      facetHits: [facet("capabilities", ids)],
      ruleRankedIds: [],
      poolCap: 10,
    });
    expect(fused).toHaveLength(10);
  });
});

describe("matchScore", () => {
  it("normalizes the RRF total against the strongest candidate in the pool", () => {
    // RRF totals depend on how many arms ran, so they are only meaningful
    // relative to each other.
    const best = matchScore({ fused: 0.05, maxFused: 0.05, geoScore: 1, timeScore: 1 });
    expect(best).toBeCloseTo(1, 10);
  });

  it("keeps a perfect semantic match with no geo signal above a weak local one", () => {
    const remoteButPerfect = matchScore({
      fused: 1,
      maxFused: 1,
      geoScore: 0,
      timeScore: 1,
    });
    const localButWeak = matchScore({
      fused: 0.2,
      maxFused: 1,
      geoScore: 1,
      timeScore: 1,
    });
    expect(remoteButPerfect).toBeGreaterThan(localButWeak);
  });

  it("returns 0 for an empty pool rather than dividing by zero", () => {
    expect(matchScore({ fused: 0, maxFused: 0, geoScore: 1, timeScore: 1 })).toBe(0);
  });
});

describe("finalScore", () => {
  it("leaves an unjudged tender on its retrieval score", () => {
    // A failed judge batch must not silently bury real matches.
    expect(finalScore(0.8, null)).toBeCloseTo(0.8, 10);
  });

  it("weights the judge above the retrieval blend once it has run", () => {
    const judgedWell = finalScore(0.5, 100);
    const judgedBadly = finalScore(0.5, 0);
    expect(judgedWell).toBeGreaterThan(0.5);
    expect(judgedBadly).toBeLessThan(0.5);
  });

  it("stays within 0..1", () => {
    expect(finalScore(1, 100)).toBeCloseTo(1, 10);
    expect(finalScore(0, 0)).toBe(0);
  });
});
