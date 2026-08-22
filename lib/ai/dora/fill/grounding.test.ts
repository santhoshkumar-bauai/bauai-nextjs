import { describe, expect, it } from "vitest";

import { flattenCompanyProfile } from "./grounding";

/**
 * Golden test on the profile flattener. This locks the refactor that lifted it
 * out of analyze.ts: the emitted keys ARE the evidence references the model is
 * allowed to cite, so a change here silently invalidates every stored run's
 * evidence.
 */
describe("flattenCompanyProfile", () => {
  it("emits dotted scalar keys under the company prefix", () => {
    const out = flattenCompanyProfile({
      name: "BAU Testbau GmbH",
      address: { street: "Königsallee 47a", postalCode: "40212", city: "Düsseldorf" },
      employees: 74,
    });
    expect(Object.fromEntries(out)).toEqual({
      "company.name": "BAU Testbau GmbH",
      "company.address.street": "Königsallee 47a",
      "company.address.postalCode": "40212",
      "company.address.city": "Düsseldorf",
      "company.employees": "74",
    });
  });

  it("indexes arrays numerically", () => {
    const out = flattenCompanyProfile({ certifications: ["ISO 9001", "SCC"] });
    expect(out.get("company.certifications.0")).toBe("ISO 9001");
    expect(out.get("company.certifications.1")).toBe("SCC");
  });

  it("drops plumbing keys, blanks and nullish values", () => {
    const out = flattenCompanyProfile({
      _id: "68b0f1",
      members: [{ userId: "u1" }],
      membershipRequests: [{ userId: "u2" }],
      trial: { endsAt: "2026-01-01" },
      createdBy: "u1",
      createdAt: "2025-01-01",
      updatedAt: "2025-06-01",
      name: "Kept GmbH",
      blank: "   ",
      missing: null,
      absent: undefined,
    });
    expect([...out.keys()]).toEqual(["company.name"]);
  });

  it("trims values and never emits a key for an empty object", () => {
    const out = flattenCompanyProfile({ name: "  Spaced GmbH  ", empty: {} });
    expect(out.get("company.name")).toBe("Spaced GmbH");
    expect(out.has("company.empty")).toBe(false);
  });
});
