import { describe, expect, it } from "vitest";

import type { StoredCitedValue } from "./citations.ts";
import { mergeFieldResults } from "./merge.ts";

function cv(
  value: unknown,
  citationState: StoredCitedValue["citationState"],
  confidence: number,
  quoteHash = "h1",
  chunkId: string | null = "c1",
): StoredCitedValue {
  return {
    value,
    confidence,
    citationState,
    citations:
      value == null
        ? []
        : [
            {
              documentRecordId: "d1",
              fileSha256: "f1",
              chunkId,
              quote: "q",
              quoteHash,
              anchor: { page: null, bbox: null, charStart: 0, charEnd: 10 },
            },
          ],
  };
}

describe("mergeFieldResults", () => {
  it("VERIFIED beats UNVERIFIED regardless of confidence", () => {
    const merged = mergeFieldResults(
      ["a"],
      [{ a: cv("x", "UNVERIFIED", 0.99) }, { a: cv("y", "VERIFIED", 0.5) }],
    );
    expect(merged.fields.a.value).toBe("y");
    expect(merged.fields.a.citationState).toBe("VERIFIED");
  });

  it("within the same state, higher confidence wins", () => {
    const merged = mergeFieldResults(
      ["a"],
      [{ a: cv("x", "VERIFIED", 0.7) }, { a: cv("y", "VERIFIED", 0.9) }],
    );
    expect(merged.fields.a.value).toBe("y");
  });

  it("collects corroborating citations from agreeing results only", () => {
    const merged = mergeFieldResults(
      ["a"],
      [
        { a: cv("x", "VERIFIED", 0.9, "h1", "c1") },
        { a: cv("x", "VERIFIED", 0.8, "h2", "c2") },
        { a: cv("z", "VERIFIED", 0.85, "h3", "c3") },
      ],
    );
    expect(merged.fields.a.value).toBe("x");
    expect(merged.fields.a.citations).toHaveLength(2);
    expect(merged.fields.a.citations.map((c) => c.quoteHash).sort()).toEqual(["h1", "h2"]);
  });

  it("dedupes identical citations", () => {
    const merged = mergeFieldResults(
      ["a"],
      [{ a: cv("x", "VERIFIED", 0.9, "h1", "c1") }, { a: cv("x", "VERIFIED", 0.8, "h1", "c1") }],
    );
    expect(merged.fields.a.citations).toHaveLength(1);
  });

  it("missing everywhere → MISSING + unresolved", () => {
    const merged = mergeFieldResults(
      ["a", "b"],
      [{ a: cv("x", "VERIFIED", 0.9) }],
    );
    expect(merged.fields.b.citationState).toBe("MISSING");
    expect(merged.unresolved).toEqual(["b"]);
  });

  it("null-valued winner is still unresolved", () => {
    const merged = mergeFieldResults(
      ["a"],
      [{ a: cv(null, "MISSING", 0) }],
    );
    expect(merged.unresolved).toEqual(["a"]);
  });

  it("handles empty result sets", () => {
    const merged = mergeFieldResults(["a"], []);
    expect(merged.fields.a.citationState).toBe("MISSING");
    expect(merged.unresolved).toEqual(["a"]);
  });
});
