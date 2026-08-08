import { describe, expect, it } from "vitest";

import { fuseRanks, RRF_K } from "./rrf.ts";

describe("fuseRanks", () => {
  it("ranks an id found by both arms above single-arm ids", () => {
    const fused = fuseRanks([
      { ids: ["a", "b", "c"] },
      { ids: ["b", "d", "e"] },
    ]);
    expect(fused[0].id).toBe("b");
  });

  it("computes the textbook RRF score", () => {
    const fused = fuseRanks([{ ids: ["a"] }, { ids: ["a"] }]);
    expect(fused[0].score).toBeCloseTo(2 / (RRF_K + 1), 10);
  });

  it("respects arm weights", () => {
    const balanced = fuseRanks([
      { ids: ["a"] },
      { ids: ["b"] },
    ]);
    // Equal ranks, equal weights → tie broken lexicographically.
    expect(balanced[0].id).toBe("a");

    const weighted = fuseRanks([
      { ids: ["a"], weight: 1 },
      { ids: ["b"], weight: 2 },
    ]);
    expect(weighted[0].id).toBe("b");
  });

  it("records per-arm ranks with null for missing arms", () => {
    const fused = fuseRanks([
      { ids: ["a", "b"] },
      { ids: ["b"] },
    ]);
    const a = fused.find((entry) => entry.id === "a");
    const b = fused.find((entry) => entry.id === "b");
    expect(a?.ranks).toEqual([0, null]);
    expect(b?.ranks).toEqual([1, 0]);
  });

  it("is deterministic on ties", () => {
    const first = fuseRanks([{ ids: ["x", "y"] }, { ids: ["y", "x"] }]);
    const second = fuseRanks([{ ids: ["x", "y"] }, { ids: ["y", "x"] }]);
    expect(first.map((e) => e.id)).toEqual(second.map((e) => e.id));
  });

  it("handles empty input", () => {
    expect(fuseRanks([])).toEqual([]);
    expect(fuseRanks([{ ids: [] }, { ids: [] }])).toEqual([]);
  });
});
