import { describe, expect, it } from "vitest";

import { cpvStemFilter } from "./cpv-names.ts";

describe("cpvStemFilter", () => {
  it("matches catalog entries that carry a check digit", () => {
    // Tenders store "45000000"; the catalog stores "45000000-7". A plain $in
    // between the two matched nothing, so cards printed raw code numbers.
    expect(cpvStemFilter(["45000000"])).toEqual({
      $or: [{ code: { $regex: "^45000000" } }],
    });
  });

  it("normalises codes that already have a check digit", () => {
    expect(cpvStemFilter(["45233120-6"])).toEqual({
      $or: [{ code: { $regex: "^45233120" } }],
    });
  });

  it("collapses duplicate stems into one clause", () => {
    expect(cpvStemFilter(["45000000", "45000000-7"])).toEqual({
      $or: [{ code: { $regex: "^45000000" } }],
    });
  });

  it("returns nothing rather than scanning the catalog for no codes", () => {
    expect(cpvStemFilter([])).toBeNull();
    expect(cpvStemFilter(["", "—"])).toBeNull();
  });
});
