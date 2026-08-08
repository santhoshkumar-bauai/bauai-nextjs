import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import { companyFilterClauses } from "./keyword.ts";
import { companyVectorFilter } from "./vector.ts";

/**
 * Tenant-leak guard: the company-corpus filter builders must emit exactly one
 * tenantId equality, never a null branch, never a tenderId clause. If this
 * test fails, stop — it protects cross-tenant isolation.
 */
describe("company-corpus filter builders", () => {
  const tenantId = new ObjectId();

  it("vector filter contains exactly one tenantId equality and no null/tenderId", () => {
    const filter = companyVectorFilter({ tenantId });
    const serialized = JSON.stringify(filter);
    expect(filter).toEqual({ $and: [{ tenantId: { $eq: tenantId } }] });
    expect(serialized).not.toContain("null");
    expect(serialized).not.toContain("tenderId");
    expect(serialized).not.toContain("$or");
  });

  it("keyword clauses contain exactly one tenantId equality and no null/tenderId", () => {
    const clauses = companyFilterClauses({ tenantId });
    expect(clauses).toHaveLength(1);
    expect(clauses[0]).toEqual({ equals: { path: "tenantId", value: tenantId } });
    const serialized = JSON.stringify(clauses);
    expect(serialized).not.toContain("null");
    expect(serialized).not.toContain("tenderId");
  });

  it("documentRecordId narrows but never widens", () => {
    const filter = companyVectorFilter({ tenantId, documentRecordId: "company:x" });
    expect(filter.$and).toHaveLength(2);
    const clauses = companyFilterClauses({ tenantId, documentRecordId: "company:x" });
    expect(clauses).toHaveLength(2);
  });
});
