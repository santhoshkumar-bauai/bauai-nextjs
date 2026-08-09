import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterChips,
  parseTenderFilters,
  removeFilterChip,
  tenderFiltersToParams,
  type TenderFilters,
} from "./filters.ts";

describe("sort round-trip", () => {
  it("parses a known sort", () => {
    expect(parseTenderFilters(new URLSearchParams("sort=deadline")).sort).toBe(
      "deadline",
    );
  });

  it("ignores an unknown sort", () => {
    expect(
      parseTenderFilters(new URLSearchParams("sort=cheapest")).sort,
    ).toBeUndefined();
  });

  it("omits the default sort from the query string", () => {
    const params = tenderFiltersToParams({ ...EMPTY_FILTERS, sort: "relevance" });
    expect(params.get("sort")).toBeNull();
  });

  it("serializes a non-default sort", () => {
    const params = tenderFiltersToParams({ ...EMPTY_FILTERS, sort: "newest" });
    expect(params.get("sort")).toBe("newest");
  });
});

describe("activeFilterChips", () => {
  const filters: TenderFilters = {
    q: "brücke",
    statuses: ["OPEN", "UPCOMING"],
    contractNatures: ["works"],
    sectors: ["45"],
    regions: [],
    deadlineInDays: 30,
    minScore: 0.5,
  };

  it("emits one chip per active value", () => {
    expect(activeFilterChips(filters).map((chip) => chip.key)).toEqual([
      "q",
      "statuses:OPEN",
      "statuses:UPCOMING",
      "contract:works",
      "sector:45",
      "deadline",
      "minScore",
    ]);
  });

  it("emits nothing when no filter is set", () => {
    expect(activeFilterChips(EMPTY_FILTERS)).toEqual([]);
  });

  it("skips a zero minScore", () => {
    expect(activeFilterChips({ ...EMPTY_FILTERS, minScore: 0 })).toEqual([]);
  });
});

describe("removeFilterChip", () => {
  const filters: TenderFilters = {
    q: "brücke",
    statuses: ["OPEN", "UPCOMING"],
    contractNatures: [],
    sectors: [],
    regions: [],
    deadlineInDays: 30,
  };

  it("drops a single value, leaving the rest of the facet", () => {
    const next = removeFilterChip(filters, {
      key: "statuses:OPEN",
      field: "statuses",
      value: "OPEN",
    });
    expect(next.statuses).toEqual(["UPCOMING"]);
    expect(next.q).toBe("brücke");
  });

  it("clears a scalar facet", () => {
    const next = removeFilterChip(filters, {
      key: "deadline",
      field: "deadlineInDays",
    });
    expect(next.deadlineInDays).toBeUndefined();
    expect(next.statuses).toEqual(["OPEN", "UPCOMING"]);
  });
});
