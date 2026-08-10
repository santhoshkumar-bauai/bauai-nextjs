import { describe, expect, it } from "vitest";

import type { ProfileTerm } from "@/lib/tenders/profile-terms";
import { buildTextArmStages } from "@/lib/tenders/text-arm";

const TERMS: ProfileTerm[] = [
  { text: "Dachabdichtung", weight: 3, source: "specialization" },
  { text: "Installation von elektrischen Leitungen", weight: 1.5, source: "cpv" },
];

type Clause = Record<string, Record<string, unknown>>;
interface Compound {
  filter: Clause[];
  must: Array<{ compound: { should: Clause[]; minimumShouldMatch: number } }>;
  should: Clause[];
}

function compoundOf(stages: Record<string, unknown>[]): Compound {
  return (stages[0] as { $search: { compound: Compound } }).$search.compound;
}

/** The `should` clauses that actually carry the terms, one per profile term. */
function termClauses(stages: Record<string, unknown>[]): Clause[] {
  return compoundOf(stages).must[0].compound.should;
}

describe("buildTextArmStages", () => {
  it("requires at least one term to match", () => {
    const compound = compoundOf(buildTextArmStages(TERMS, { countries: ["DE"] }));
    expect(compound.must).toHaveLength(1);
    expect(compound.must[0].compound.minimumShouldMatch).toBe(1);
    expect(compound.must[0].compound.should).toHaveLength(TERMS.length);
  });

  it("keeps the region boost out of the match requirement", () => {
    // Flat, the region clause satisfies `minimumShouldMatch` on its own and the
    // arm returns every notice in the state, matched or not — a real bug that
    // put road gritting and postal services in a bridge builder's feed.
    const compound = compoundOf(
      buildTextArmStages(TERMS, { countries: ["DE"], nutsCodes: ["DEE0"] }),
    );
    expect(compound.must[0].compound.should.some((clause) => clause.in)).toBe(false);
    expect(compound.should).toHaveLength(1);
    expect(compound.should[0].in.path).toBe("regions");
  });

  it("phrase-matches multi-word terms and text-matches single words", () => {
    const clauses = termClauses(buildTextArmStages(TERMS, { countries: ["DE"] }));
    expect(clauses[0].text.query).toBe("Dachabdichtung");
    expect(clauses[1].phrase.query).toBe("Installation von elektrischen Leitungen");
    // Slop covers the declensions and articles German puts between the words.
    expect(clauses[1].phrase.slop).toBeGreaterThan(0);
  });

  it("carries each term's weight through as a boost", () => {
    type Boosted = { boost: { value: number } };
    const clauses = termClauses(buildTextArmStages(TERMS, { countries: ["DE"] }));
    expect((clauses[0].text.score as Boosted).boost.value).toBe(3);
    expect((clauses[1].phrase.score as Boosted).boost.value).toBe(1.5);
  });

  it("searches lot text as well as the notice body", () => {
    const paths = termClauses(buildTextArmStages(TERMS, { countries: ["DE"] }))[0]
      .text.path as string[];
    // On a lot-split notice the trade is named in the lot and nowhere else.
    expect(paths).toContain("lots.title");
    expect(paths).toContain("lots.description");
  });

  it("filters to biddable notices in the requested countries", () => {
    const filter = compoundOf(buildTextArmStages(TERMS, { countries: ["DE", "AT"] }))
      .filter;
    expect(filter).toContainEqual({ equals: { path: "isVisible", value: true } });
    expect(filter).toContainEqual({ in: { path: "countries", value: ["DE", "AT"] } });
  });

  it("only restricts by region when a region filter is given", () => {
    const boosted = compoundOf(
      buildTextArmStages(TERMS, { countries: ["DE"], nutsCodes: ["DEE0"] }),
    ).filter;
    expect(boosted.some((clause) => clause.in?.path === "regions")).toBe(false);

    const filtered = compoundOf(
      buildTextArmStages(TERMS, { countries: ["DE"], regionFilter: ["DEE0"] }),
    ).filter;
    expect(filtered).toContainEqual({ in: { path: "regions", value: ["DEE0"] } });
  });
});
