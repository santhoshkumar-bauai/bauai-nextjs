import { describe, expect, it } from "vitest";

import { extractLegalRefs } from "./legal-refs.ts";

describe("extractLegalRefs", () => {
  it("finds a plain reference", () => {
    expect(extractLegalRefs("gemäß § 13 VOB/B gilt")).toEqual(["§ 13 VOB/B"]);
  });

  it("normalizes missing space after §", () => {
    expect(extractLegalRefs("nach §13 VOB/B")).toEqual(["§ 13 VOB/B"]);
  });

  it("keeps Abs. and Nr. qualifiers", () => {
    expect(extractLegalRefs("Der Auftraggeber kann nach § 8 Abs. 4 Nr. 2 VOB/A ausschließen.")).toEqual([
      "§ 8 Abs. 4 Nr. 2 VOB/A",
    ]);
  });

  it("recognizes letter-suffixed paragraphs", () => {
    expect(extractLegalRefs("Nachweis nach § 6a VOB/A erforderlich")).toEqual([
      "§ 6a VOB/A",
    ]);
  });

  it("finds several distinct codes in one text", () => {
    const refs = extractLegalRefs(
      "Es gelten § 122 GWB, § 46 VgV sowie § 13 VOB/B entsprechend.",
    );
    expect(refs).toContain("§ 122 GWB");
    expect(refs).toContain("§ 46 VgV");
    expect(refs).toContain("§ 13 VOB/B");
  });

  it("deduplicates repeated references", () => {
    expect(
      extractLegalRefs("§ 13 VOB/B ... siehe erneut § 13 VOB/B"),
    ).toEqual(["§ 13 VOB/B"]);
  });

  it("ignores paragraph signs without a known code", () => {
    expect(extractLegalRefs("§ 5 der Hausordnung")).toEqual([]);
  });

  it("handles double section signs", () => {
    expect(extractLegalRefs("gemäß §§ 97 GWB")).toEqual(["§ 97 GWB"]);
  });
});
