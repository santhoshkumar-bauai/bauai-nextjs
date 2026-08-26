import { describe, expect, it } from "vitest";

import { hashCompanyData } from "./company-hash.ts";
import type { CompanyContextInput } from "./company-context.ts";

/**
 * The regression these pin: `canonicalize` used to walk whatever
 * `companyProfileInput` handed it, and on a hydrated Mongoose document that
 * includes subdocuments holding a reference back to their parent. The walk
 * followed it and died with "Maximum call stack size exceeded", which reached
 * users as a 502 on the AI-recommendation endpoint and as a broken staleness
 * check on verdicts, reports and tender coverage.
 */

const base = (): CompanyContextInput =>
  ({
    name: "Wirl Ing",
    businessDomain: "construction",
    region: "Magdeburg, Germany",
    address: "Somewhere 1",
    employeeCount: 12,
    services: ["Tiefbau"],
    cpvCodes: ["45233120-6"],
    trade: ["Straßenbau"],
    specializations: [],
    certifications: [],
    projectSizeRange: null,
    insurances: [],
    referenceProjects: [],
    knowledgeBase: null,
  }) as unknown as CompanyContextInput;

describe("hashCompanyData", () => {
  it("is stable across calls and sensitive to profile changes", () => {
    const first = hashCompanyData(base(), []);
    expect(hashCompanyData(base(), [])).toBe(first);

    const changed = { ...base(), employeeCount: 13 } as CompanyContextInput;
    expect(hashCompanyData(changed, [])).not.toBe(first);
  });

  it("ignores key order — the hash is of the data, not the object layout", () => {
    const ordered = base();
    const reordered = Object.fromEntries(
      Object.entries(ordered as unknown as Record<string, unknown>).reverse(),
    ) as unknown as CompanyContextInput;

    expect(hashCompanyData(reordered, [])).toBe(hashCompanyData(ordered, []));
  });

  it("sorts embedded-doc identities so scan order cannot change the hash", () => {
    const docs = [
      { documentRecordId: "b", fileSha256: "2" },
      { documentRecordId: "a", fileSha256: "1" },
    ];
    expect(hashCompanyData(base(), docs)).toBe(
      hashCompanyData(base(), [...docs].reverse()),
    );
  });

  it("survives a parent back-reference instead of overflowing the stack", () => {
    // Exactly the shape a Mongoose subdocument array has: each entry points
    // back at the document that owns it.
    const profile = base() as unknown as Record<string, unknown>;
    const insurance: Record<string, unknown> = { type: "liability", amount: "5000000" };
    insurance.$__parent = profile;
    profile.insurances = [insurance];

    expect(() => hashCompanyData(profile as unknown as CompanyContextInput, [])).not.toThrow();
  });

  it("does not treat a repeated (non-cyclic) reference as circular", () => {
    // A DAG is legal data. Marking it circular would silently change the hash
    // of every company that happens to share a nested object.
    const shared = { type: "liability", amount: "5000000" };
    const withShared = {
      ...base(),
      insurances: [shared, shared],
    } as unknown as CompanyContextInput;
    const withCopies = {
      ...base(),
      insurances: [{ ...shared }, { ...shared }],
    } as unknown as CompanyContextInput;

    expect(hashCompanyData(withShared, [])).toBe(hashCompanyData(withCopies, []));
  });
});
