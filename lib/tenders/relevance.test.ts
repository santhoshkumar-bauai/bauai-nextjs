import { describe, expect, it } from "vitest";
import type { TenderSort } from "./filters.ts";
import {
  buildRelevancePipeline,
  stripCheckDigit,
  toFamilyPrefixes,
} from "./relevance.ts";

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

describe("sort ordering", () => {
  const itemStages = (sort?: TenderSort) => {
    const { pipeline } = buildRelevancePipeline(
      {
        companyCpvCodes: ["45000000-7"],
        nuts: { country: "DE", nuts1: "DE3", source: "nuts-code" },
      },
      { now: new Date("2026-01-01T00:00:00.000Z"), page: 0, pageSize: 20, sort },
    );
    const facet = pipeline.at(-1) as {
      $facet: { items: Record<string, unknown>[] };
    };
    return facet.$facet.items;
  };

  it("leaves the ranked order untouched for relevance", () => {
    expect(itemStages()[0]).toHaveProperty("$skip");
  });

  it("re-sorts inside the ranked pool, before paging", () => {
    const stages = itemStages("deadline");
    expect(stages[0]).toHaveProperty("$addFields");
    expect(stages[1]).toEqual({ $sort: { sortKey: 1, score: -1, _id: 1 } });
    expect(stages[2]).toHaveProperty("$skip");
  });

  it("orders newest-first by publication date", () => {
    expect(itemStages("newest")[1]).toEqual({
      $sort: { sortKey: -1, score: -1, _id: 1 },
    });
  });

  it("keeps the total branch independent of the sort", () => {
    const { pipeline } = buildRelevancePipeline(
      {
        companyCpvCodes: ["45000000-7"],
        nuts: { country: "DE", nuts1: "DE3", source: "nuts-code" },
      },
      {
        now: new Date("2026-01-01T00:00:00.000Z"),
        page: 0,
        pageSize: 20,
        sort: "deadline",
      },
    );
    const facet = pipeline.at(-1) as {
      $facet: { total: Record<string, unknown>[] };
    };
    expect(facet.$facet.total).toEqual([{ $count: "value" }]);
  });
});
