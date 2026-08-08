import { describe, expect, it } from "vitest";

import { buildFullCompanyContext } from "./company-context.ts";
import { hashCompanyData } from "./company-hash.ts";

const FULL_PROFILE = {
  name: "Bau Muster GmbH",
  businessDomain: "CONSTRUCTION",
  region: "Stuttgart",
  employeeCount: 85,
  services: ["Rohbau", "Tiefbau"],
  cpvCodes: ["45000000"],
  certifications: ["ISO 9001"],
  insurances: [{ type: "Betriebshaftpflicht", amount: "5 Mio. EUR", details: "AXA" }],
  referenceProjects: [
    { title: "KiTa Neubau", client: "Stadt Stuttgart", year: "2024", value: "2,4 Mio. EUR" },
  ],
  knowledgeBase: {
    companyExtended: { legalForm: "GmbH", foundingYear: "1987" },
    financialInfo: { revenueCurrent: "12 Mio. EUR" },
    technicalNarratives: { capabilitiesStatement: "Komplettleistungen im Hochbau." },
  },
};

describe("buildFullCompanyContext", () => {
  it("includes every populated section", () => {
    const context = buildFullCompanyContext(FULL_PROFILE);
    expect(context).toContain("## Identity");
    expect(context).toContain("Bau Muster GmbH");
    expect(context).toContain("Legal form: GmbH");
    expect(context).toContain("## Capabilities");
    expect(context).toContain("Rohbau");
    expect(context).toContain("## Financials");
    expect(context).toContain("12 Mio. EUR");
    expect(context).toContain("## Insurance");
    expect(context).toContain("Betriebshaftpflicht: 5 Mio. EUR — AXA");
    expect(context).toContain("## Reference projects");
    expect(context).toContain("KiTa Neubau");
  });

  it("omits absent sections entirely", () => {
    const context = buildFullCompanyContext({ name: "Minimal AG" });
    expect(context).toContain("## Identity");
    expect(context).not.toContain("## Financials");
    expect(context).not.toContain("## Insurance");
    expect(context).not.toContain("## Bonding");
    expect(context).not.toContain("undefined");
    expect(context).not.toContain("null");
  });
});

describe("hashCompanyData", () => {
  const docs = [
    { documentRecordId: "company:b", fileSha256: "2".repeat(64) },
    { documentRecordId: "company:a", fileSha256: "1".repeat(64) },
  ];

  it("is stable across key and doc ordering", () => {
    const reordered = Object.fromEntries(
      Object.entries(FULL_PROFILE).reverse(),
    ) as typeof FULL_PROFILE;
    expect(hashCompanyData(FULL_PROFILE, docs)).toBe(
      hashCompanyData(reordered, [...docs].reverse()),
    );
  });

  it("changes when a profile field changes", () => {
    expect(hashCompanyData(FULL_PROFILE, docs)).not.toBe(
      hashCompanyData({ ...FULL_PROFILE, employeeCount: 86 }, docs),
    );
  });

  it("changes when an embedded document is added or replaced", () => {
    const base = hashCompanyData(FULL_PROFILE, docs);
    expect(base).not.toBe(
      hashCompanyData(FULL_PROFILE, [
        ...docs,
        { documentRecordId: "company:c", fileSha256: "3".repeat(64) },
      ]),
    );
    expect(base).not.toBe(
      hashCompanyData(FULL_PROFILE, [
        docs[0],
        { documentRecordId: "company:a", fileSha256: "9".repeat(64) },
      ]),
    );
  });
});
