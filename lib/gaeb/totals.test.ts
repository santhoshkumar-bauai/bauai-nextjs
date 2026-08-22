import { describe, expect, it } from "vitest";

import { computeTotals, roundGaeb } from "./totals";
import type { GaebItem } from "./types";

function item(overrides: Partial<GaebItem> & { key: string }): GaebItem {
  return {
    sourceIndex: 0,
    sourceId: null,
    rNoPart: "1",
    oz: "01.0001",
    categoryKey: "c-0001",
    shortText: "Test",
    longText: null,
    longTextTruncated: false,
    qty: 1,
    qtyUnit: "St",
    existingUnitPrice: null,
    existingTotal: null,
    markers: [],
    alternative: null,
    notInTotal: false,
    ...overrides,
  };
}

describe("roundGaeb", () => {
  it("rounds half away from zero on true decimal halves", () => {
    expect(roundGaeb(1.005)).toBe(1.01);
    expect(roundGaeb(-1.005)).toBe(-1.01);
    expect(roundGaeb(2.675)).toBe(2.68);
    expect(roundGaeb(0.125)).toBe(0.13);
    expect(roundGaeb(-0.125)).toBe(-0.13);
  });

  it("absorbs binary float dust", () => {
    expect(roundGaeb(19.99 * 3)).toBe(59.97);
    expect(roundGaeb(0.1 + 0.2)).toBe(0.3);
    expect(roundGaeb(1.115 * 3)).toBe(3.35);
  });

  it("passes exact values through", () => {
    expect(roundGaeb(0)).toBe(0);
    expect(roundGaeb(23.4)).toBe(23.4);
    expect(roundGaeb(-17)).toBe(-17);
  });
});

describe("computeTotals", () => {
  const items = [
    item({ key: "i-0001", qty: 50, categoryKey: "c-0002" }),
    item({ key: "i-0002", qty: 12, categoryKey: "c-0002" }),
    item({ key: "i-0003", qty: 10, categoryKey: "c-0003", notInTotal: true, markers: ["provisional"] }),
    item({ key: "i-0004", qty: null, categoryKey: "c-0003", markers: ["lump_sum"] }),
  ];
  const categories = [
    { key: "c-0001", parentKey: null },
    { key: "c-0002", parentKey: "c-0001" },
    { key: "c-0003", parentKey: "c-0001" },
  ];

  it("computes line totals, rollups, VAT, and exclusions", () => {
    const totals = computeTotals({
      items,
      prices: new Map([
        ["i-0001", 23.4],
        ["i-0002", 85.1],
        ["i-0003", 99],
        ["i-0004", 1500],
      ]),
      vatRate: 19,
      categories,
    });

    expect(totals.byItem.get("i-0001")?.total).toBe(1170);
    expect(totals.byItem.get("i-0002")?.total).toBe(1021.2);
    // Excluded from rollups but still displayable per line.
    expect(totals.byItem.get("i-0003")?.total).toBe(990);
    // Lump sum without qty prices as 1 unit.
    expect(totals.byItem.get("i-0004")?.total).toBe(1500);

    expect(totals.net).toBe(3691.2);
    expect(totals.vat).toBe(701.33);
    expect(totals.gross).toBe(4392.53);
    expect(totals.excludedKeys).toEqual(["i-0003"]);
    expect(totals.unpricedCount).toBe(0);

    expect(totals.byCategory.get("c-0002")?.net).toBe(2191.2);
    expect(totals.byCategory.get("c-0003")?.net).toBe(1500);
    // Ancestor rollup includes both children.
    expect(totals.byCategory.get("c-0001")?.net).toBe(3691.2);
    expect(totals.byCategory.get("c-0001")?.itemCount).toBe(3);
  });

  it("counts unpriced in-scope items and tolerates null vat", () => {
    const totals = computeTotals({
      items,
      prices: new Map([["i-0001", 10]]),
      vatRate: null,
      categories,
    });
    expect(totals.net).toBe(500);
    expect(totals.vat).toBe(0);
    expect(totals.gross).toBe(500);
    // i-0002 and i-0004 lack prices; the excluded i-0003 never counts.
    expect(totals.unpricedCount).toBe(2);
    expect(totals.byItem.get("i-0002")?.total).toBeNull();
  });

  it("rounds each line before summing, as GAEB requires", () => {
    const totals = computeTotals({
      items: [
        item({ key: "a", qty: 3 }),
        item({ key: "b", qty: 3 }),
      ],
      prices: new Map([
        ["a", 1.115],
        ["b", 1.115],
      ]),
      vatRate: null,
    });
    // Each line: round2(3.345) = 3.35; sum 6.70 — not round2(6.69).
    expect(totals.byItem.get("a")?.total).toBe(3.35);
    expect(totals.net).toBe(6.7);
  });
});
