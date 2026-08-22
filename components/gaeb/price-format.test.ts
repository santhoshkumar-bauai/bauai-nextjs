import { describe, expect, it } from "vitest";

import { parsePriceInput } from "./price-format";

describe("parsePriceInput", () => {
  it.each([
    // [input, locale, expected]
    ["23,40", "de", 23.4],
    ["23.40", "de", 23.4],
    ["1.234,56", "de", 1234.56],
    ["1,234.56", "en", 1234.56],
    ["1234.56", "en", 1234.56],
    ["1.234", "de", 1234],
    ["1.234", "en", 1.234],
    ["1.234.567", "en", 1234567],
    ["12,5", "de", 12.5],
    ["12,5", "en", 12.5],
    ["1 234,56", "de", 1234.56],
    ["27,5045", "de", 27.505],
    ["€ 99,90", "de", 99.9],
    ["-5,25", "de", -5.25],
    ["0", "de", 0],
  ])("parses %s (%s) → %s", (input, locale, expected) => {
    expect(parsePriceInput(input, locale)).toBe(expected);
  });

  it("returns null for empty and undefined for garbage", () => {
    expect(parsePriceInput("", "de")).toBeNull();
    expect(parsePriceInput("   ", "de")).toBeNull();
    expect(parsePriceInput("abc", "de")).toBeUndefined();
    expect(parsePriceInput("1,2,3", "de")).toBeUndefined();
    expect(parsePriceInput("12,34.56,78", "de")).toBeUndefined();
  });
});
