import { describe, expect, it } from "vitest";
import { stripCheckDigit, toFamilyPrefixes } from "./relevance.ts";

describe("stripCheckDigit", () => {
  it("removes the check digit suffix", () => {
    expect(stripCheckDigit("45000000-7")).toBe("45000000");
  });

  it("passes through codes without a check digit", () => {
    expect(stripCheckDigit("48218000")).toBe("48218000");
  });

  it("drops any non-digit characters", () => {
    expect(stripCheckDigit("45 000 000-7")).toBe("45000000");
  });
});

describe("toFamilyPrefixes", () => {
  it("broadens division-level codes to their family", () => {
    expect(toFamilyPrefixes(["45000000"])).toEqual(["45"]);
  });

  it("keeps specific codes narrow", () => {
    expect(toFamilyPrefixes(["45233120"])).toEqual(["4523312"]);
  });

  it("drops prefixes subsumed by a shorter one", () => {
    expect(toFamilyPrefixes(["45000000", "45233120"])).toEqual(["45"]);
  });

  it("keeps distinct families side by side", () => {
    expect(toFamilyPrefixes(["45000000", "71000000"]).sort()).toEqual([
      "45",
      "71",
    ]);
  });

  it("deduplicates equivalent inputs", () => {
    expect(toFamilyPrefixes(["45000000", "45000000"])).toEqual(["45"]);
  });

  it("returns nothing for empty input", () => {
    expect(toFamilyPrefixes([])).toEqual([]);
  });
});
