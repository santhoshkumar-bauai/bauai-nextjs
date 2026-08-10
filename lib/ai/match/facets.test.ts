import { describe, expect, it } from "vitest";

import type { CompanyContextInput } from "../fit/company-context.ts";
import {
  buildCompanyFacets,
  documentFacetWeight,
  MIN_FACET_CHARS,
  type DocumentFacetInput,
} from "./facets.ts";

const LONG = (seed: string) => seed.repeat(Math.ceil(400 / seed.length));

const FULL_COMPANY: CompanyContextInput = {
  name: "Musterbau GmbH",
  businessDomain: "CONSTRUCTION",
  region: "Bochum, Germany",
  services: ["Building construction", "Road construction"],
  trade: ["Hochbau", "Tiefbau"],
  specializations: ["Sanierung denkmalgeschützter Fassaden"],
  cpvCodes: ["45000000-7"],
  certifications: ["ISO 9001", "SCC**"],
  employeeCount: 120,
  referenceProjects: [
    { title: "Stadthalle Bochum", description: LONG("Fassadensanierung "), year: "2024" },
    { title: "Schulzentrum Essen", description: LONG("Rohbauarbeiten "), year: "2023" },
  ],
  knowledgeBase: {
    companyExtended: { description: LONG("Familienbetrieb seit 1954. ") },
    technicalNarratives: {
      capabilitiesStatement: LONG("Wir führen schlüsselfertige Projekte aus. "),
      pastPerformanceSummary: LONG("Termintreue über 98 Prozent. "),
    },
  },
};

const CPV_NAMES = ["Bauarbeiten / Construction work"];

const build = (
  company: CompanyContextInput,
  documents: DocumentFacetInput[] = [],
  maxFacets = 24,
) => buildCompanyFacets({ company, cpvNames: CPV_NAMES, documents, maxFacets });

describe("buildCompanyFacets", () => {
  it("splits a full profile into capability, reference and qualification facets", () => {
    const { facets } = build(FULL_COMPANY);
    const keys = facets.map((facet) => facet.key);

    expect(keys).toContain("capabilities");
    expect(keys).toContain("qualifications");
    expect(keys).toContain("reference:0");
    expect(keys).toContain("reference:1");
  });

  it("embeds CPV names rather than codes", () => {
    // The whole point: "45000000" is noise to an embedding model,
    // "Bauarbeiten" is meaning.
    const capabilities = build(FULL_COMPANY).facets.find(
      (facet) => facet.key === "capabilities",
    );
    expect(capabilities?.text).toContain("Bauarbeiten / Construction work");
    expect(capabilities?.text).not.toContain("45000000");
  });

  it("weights capabilities above references and qualifications", () => {
    const { facets } = build(FULL_COMPANY);
    const weight = (key: string) =>
      facets.find((facet) => facet.key === key)?.weight ?? 0;

    expect(weight("capabilities")).toBeGreaterThan(weight("reference:0"));
    expect(weight("reference:0")).toBeGreaterThan(weight("qualifications"));
  });

  it("produces no facets at all for an empty profile", () => {
    const { facets, skipped } = build({});
    expect(facets).toEqual([]);
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("skips facets too thin to be worth a retrieval arm, and says so", () => {
    // A company with nothing but two trade words: the capabilities text is
    // real but far too short to point anywhere meaningful in vector space.
    const { facets, skipped } = build({ trade: ["Dach"] }, []);
    expect(facets.map((f) => f.key)).not.toContain("capabilities");
    expect(skipped).toContainEqual({ key: "capabilities", reason: "too_short" });
  });

  it("keeps a CPV-only company matchable through its resolved code names", () => {
    const cpvOnly = buildCompanyFacets({
      company: { cpvCodes: ["45000000-7"] },
      cpvNames: [LONG("Bauarbeiten / Construction work, ")],
      documents: [],
      maxFacets: 24,
    });
    expect(cpvOnly.facets.map((facet) => facet.key)).toContain("capabilities");
  });
});

describe("document facets", () => {
  const doc = (id: string): DocumentFacetInput => ({
    documentRecordId: id,
    fileName: `${id}.pdf`,
    text: LONG("Referenzprojekt Beschreibung "),
  });

  it("labels document facets with their filename for the 'matched via' line", () => {
    const { facets } = build(FULL_COMPANY, [doc("company:1")]);
    const facet = facets.find((entry) => entry.key === "doc:company:1");
    expect(facet?.kind).toBe("document");
    expect(facet?.label).toBe("company:1.pdf");
  });

  it("never lets a pile of uploads outvote the capabilities facet", () => {
    // Twelve PDFs must not drag the feed toward whatever the paperwork
    // discusses at 12:1 against what the company says it does.
    const documents = Array.from({ length: 12 }, (_, i) => doc(`company:${i}`));
    const { facets } = build(FULL_COMPANY, documents);

    const capabilities = facets.find((facet) => facet.key === "capabilities");
    const documentTotal = facets
      .filter((facet) => facet.kind === "document")
      .reduce((sum, facet) => sum + facet.weight, 0);

    expect(capabilities?.weight).toBeGreaterThan(documentTotal);
  });

  it("keeps the total document budget constant as uploads grow", () => {
    const total = (n: number) => documentFacetWeight(n) * n;
    expect(total(12)).toBeCloseTo(total(1), 10);
    expect(total(12)).toBeCloseTo(total(3), 10);
  });

  it("gives profile facets the budget when the facet cap is tight", () => {
    const documents = Array.from({ length: 12 }, (_, i) => doc(`company:${i}`));
    const { facets } = build(FULL_COMPANY, documents, 4);

    expect(facets).toHaveLength(4);
    expect(facets.filter((facet) => facet.kind === "profile").length).toBeGreaterThan(0);
  });

  it("drops empty documents rather than embedding whitespace", () => {
    const { facets, skipped } = build(FULL_COMPANY, [
      { documentRecordId: "company:empty", fileName: "scan.pdf", text: "   " },
    ]);
    expect(facets.map((f) => f.key)).not.toContain("doc:company:empty");
    expect(skipped).toContainEqual({ key: "doc:company:empty", reason: "absent" });
  });

  it("treats a near-empty extraction as too short", () => {
    const { skipped } = build(FULL_COMPANY, [
      {
        documentRecordId: "company:thin",
        fileName: "scan.pdf",
        text: "x".repeat(MIN_FACET_CHARS - 1),
      },
    ]);
    expect(skipped).toContainEqual({ key: "doc:company:thin", reason: "too_short" });
  });
});
