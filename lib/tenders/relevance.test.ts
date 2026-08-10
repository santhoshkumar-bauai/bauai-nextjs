import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import type { TenderSort } from "./filters.ts";
import {
  buildCpvPrefixSets,
  buildGeoPipeline,
  buildRelevancePipeline,
  cpvStem,
  RANK_CAP,
  stripCheckDigit,
  toFamilyPrefixes,
} from "./relevance.ts";

const NUTS = { country: "DE", nuts1: "DE3", source: "nuts-code" } as const;
const NOW = new Date("2026-01-01T00:00:00.000Z");

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

describe("cpvStem", () => {
  it("reduces a division-level code to its division", () => {
    expect(cpvStem("45000000")).toBe("45");
  });

  it("keeps every significant digit of a specific code", () => {
    expect(cpvStem("45233120")).toBe("4523312");
  });

  it("never falls below the two-digit division", () => {
    expect(cpvStem("70000000")).toBe("70");
  });

  it("tolerates a check digit", () => {
    expect(cpvStem("45112700-2")).toBe("451127");
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

describe("buildCpvPrefixSets", () => {
  it("lets a division-level code claim the division and nothing deeper", () => {
    // Holding "45000000" means "we do construction" — it must not score as a
    // precise match against every tender in division 45.
    expect([...buildCpvPrefixSets(["45000000"]).keys()]).toEqual([2]);
    expect(buildCpvPrefixSets(["45000000"]).get(2)).toEqual(["45"]);
  });

  it("registers a specific code at every depth it can support", () => {
    const sets = buildCpvPrefixSets(["45233120"]);
    expect([...sets.keys()]).toEqual([2, 3, 4, 5, 6, 7]);
    expect(sets.get(7)).toEqual(["4523312"]);
    expect(sets.get(4)).toEqual(["4523"]);
  });

  it("merges codes of different specificity into one ladder", () => {
    const sets = buildCpvPrefixSets(["45000000", "45112700"]);
    // Both codes share the division, and only the specific one reaches depth 6.
    expect(sets.get(2)).toEqual(["45"]);
    expect(sets.get(6)).toEqual(["451127"]);
  });

  it("returns nothing when the company has no codes", () => {
    expect(buildCpvPrefixSets([]).size).toBe(0);
  });
});

describe("score weighting", () => {
  const scoreExpr = () => {
    const { pipeline } = buildRelevancePipeline(
      { companyCpvCodes: ["45233120-6"], nuts: NUTS },
      { now: NOW, page: 0, pageSize: 20 },
    );
    const stage = pipeline[2] as {
      $addFields: { score: { $add: Array<{ $multiply: [number, string] }> } };
    };
    return stage.$addFields.score.$add;
  };

  it("weights fit above timing", () => {
    const [cpv, geo, time] = scoreExpr();
    expect(cpv.$multiply[1]).toBe("$cpvScore");
    expect(geo.$multiply[1]).toBe("$geoScore");
    expect(time.$multiply[1]).toBe("$timeScore");
    expect(cpv.$multiply[0]).toBeGreaterThan(geo.$multiply[0]);
    expect(geo.$multiply[0]).toBeGreaterThan(time.$multiply[0]);
  });

  it("keeps the weights a partition of 1", () => {
    const sum = scoreExpr().reduce((acc, term) => acc + term.$multiply[0], 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("scores nothing on CPV when the company declared no codes", () => {
    const { pipeline } = buildRelevancePipeline(
      { companyCpvCodes: [], nuts: NUTS },
      { now: NOW, page: 0, pageSize: 20 },
    );
    const stage = pipeline[1] as { $addFields: { cpvScore: unknown } };
    expect(stage.$addFields.cpvScore).toBe(0);
  });
});

describe("paging and totals", () => {
  const facetOf = (sort?: TenderSort) => {
    const { pipeline } = buildRelevancePipeline(
      { companyCpvCodes: ["45000000-7"], nuts: NUTS },
      { now: NOW, page: 0, pageSize: 20, sort },
    );
    return (
      pipeline.at(-1) as {
        $facet: {
          items: Record<string, unknown>[];
          total: Record<string, unknown>[];
        };
      }
    ).$facet;
  };

  it("counts every match, not just the ranked pool", () => {
    // The rank cap lives in the `items` branch, so `$count` sees the full
    // candidate set — a feed of 5k tenders must not report "500".
    const { items, total } = facetOf();
    expect(total).toEqual([{ $count: "value" }]);
    expect(items[1]).toEqual({ $limit: RANK_CAP });
  });

  it("ranks by score before capping and paging", () => {
    const stages = facetOf().items;
    expect(stages[0]).toEqual({ $sort: { score: -1, submissionDeadline: 1, _id: 1 } });
    expect(stages[1]).toEqual({ $limit: RANK_CAP });
    expect(stages[2]).toHaveProperty("$skip");
  });

  it("re-sorts inside the ranked pool, before paging", () => {
    const stages = facetOf("deadline").items;
    expect(stages[2]).toHaveProperty("$addFields");
    expect(stages[3]).toEqual({ $sort: { sortKey: 1, score: -1, _id: 1 } });
    expect(stages[4]).toHaveProperty("$skip");
  });

  it("orders newest-first by publication date", () => {
    expect(facetOf("newest").items[3]).toEqual({
      $sort: { sortKey: -1, score: -1, _id: 1 },
    });
  });

  it("keeps the total branch independent of the sort", () => {
    expect(facetOf("deadline").total).toEqual([{ $count: "value" }]);
  });
});

describe("includeIds (AI matching)", () => {
  const ids = [new ObjectId(), new ObjectId()];
  const matchOf = (options: Partial<Parameters<typeof buildRelevancePipeline>[1]> = {}) => {
    const { pipeline } = buildRelevancePipeline(
      { companyCpvCodes: ["45000000-7"], nuts: NUTS },
      { now: NOW, page: 0, pageSize: 20, ...options },
    );
    return (pipeline[0] as { $match: Record<string, unknown> }).$match;
  };

  it("restricts scoring to the supplied candidates", () => {
    expect(matchOf({ includeIds: ids })._id).toEqual({ $in: ids });
  });

  it("skips the CPV/NUTS recall clause", () => {
    // The whole reason a tender reaches the AI shortlist may be that CPV and
    // NUTS both missed it — re-applying recall here would delete it again.
    const withIds = matchOf({ includeIds: ids });
    const withoutIds = matchOf();
    const recallClause = (match: Record<string, unknown>) =>
      (match.$and as Record<string, unknown>[]).some((clause) => "$or" in clause &&
        (clause.$or as Record<string, unknown>[]).some((entry) => "cpvCodes" in entry));

    expect(recallClause(withoutIds)).toBe(true);
    expect(recallClause(withIds)).toBe(false);
  });

  it("folds exclusions into the candidate set rather than clobbering it", () => {
    // `$in` and `$nin` on the same field would overwrite each other.
    const excluded = ids[0];
    const match = matchOf({ includeIds: ids, excludeIds: [excluded] });
    expect(match._id).toEqual({ $in: [ids[1]] });
  });

  it("leaves the score expressions untouched", () => {
    const scoreStage = (options: Parameters<typeof buildRelevancePipeline>[1]) =>
      buildRelevancePipeline({ companyCpvCodes: ["45000000-7"], nuts: NUTS }, options)
        .pipeline[1];

    expect(
      scoreStage({ now: NOW, page: 0, pageSize: 20, includeIds: ids }),
    ).toEqual(scoreStage({ now: NOW, page: 0, pageSize: 20 }));
  });

  it("still enforces visibility, status and the deadline rule", () => {
    const match = matchOf({ includeIds: ids });
    expect(match.isVisible).toBe(true);
    expect(match.status).toBeDefined();
    expect(match.$and).toContainEqual({
      $or: [{ submissionDeadline: null }, { submissionDeadline: { $gte: NOW } }],
    });
  });
});

describe("nearest sort", () => {
  const itemsFor = (companyPoint?: { lat: number; lng: number } | null) =>
    (
      buildRelevancePipeline(
        { companyCpvCodes: ["45233120-6"], nuts: NUTS, companyPoint },
        { now: NOW, page: 0, pageSize: 20, sort: "nearest" },
      ).pipeline.at(-1) as { $facet: { items: Record<string, unknown>[] } }
    ).$facet.items;

  it("orders by distance, nearest first, inside the ranked pool", () => {
    const stages = itemsFor({ lat: 51.48, lng: 7.21 });
    expect(stages[0]).toEqual({ $sort: { score: -1, submissionDeadline: 1, _id: 1 } });
    expect(stages[1]).toEqual({ $limit: RANK_CAP });
    const sort = stages.find((stage) => "$sort" in stage && stage !== stages[0]);
    expect(sort).toEqual({ $sort: { sortDistanceKm: 1, score: -1, _id: 1 } });
  });

  it("resolves coordinates from the shared postal cache", () => {
    const lookup = itemsFor({ lat: 51.48, lng: 7.21 }).find((stage) => "$lookup" in stage);
    expect(lookup).toMatchObject({ $lookup: { from: "geo_cache", as: "geoCacheHit" } });
  });

  it("still orders by NUTS tier when the company has no coordinates", () => {
    // Region text alone resolves a NUTS chain, so "nearest" stays meaningful —
    // it just cannot separate two tenders inside the same region.
    const stages = itemsFor(null);
    expect(stages.some((stage) => "$lookup" in stage)).toBe(false);
    expect(stages.some((stage) => "$sort" in stage && "sortDistanceKm" in
      (stage.$sort as Record<string, unknown>))).toBe(true);
  });

  it("never leaks its working fields into the page payload", () => {
    const project = itemsFor({ lat: 51.48, lng: 7.21 }).at(-1) as {
      $project: Record<string, unknown>;
    };
    for (const field of ["geoCacheKey", "geoCacheHit", "resolvedPoint", "sortDistanceKm"]) {
      expect(project.$project).not.toHaveProperty(field);
    }
  });
});

describe("buildGeoPipeline", () => {
  it("ranks and caps markers before projecting them", () => {
    // Regression: the marker pipeline used to be derived by lopping the last
    // stage off the list pipeline, which silently dropped the sort and cap the
    // moment the list grew a `$facet`.
    const { pipeline } = buildGeoPipeline(
      { companyCpvCodes: ["45233120-6"], nuts: NUTS },
      { now: NOW, markerCap: 42 },
    );
    expect(pipeline.at(-3)).toEqual({
      $sort: { score: -1, submissionDeadline: 1, _id: 1 },
    });
    expect(pipeline.at(-2)).toEqual({ $limit: 42 });
    expect(pipeline.at(-1)).toHaveProperty("$project");
    expect(pipeline.some((stage) => "$facet" in stage)).toBe(false);
  });
});
