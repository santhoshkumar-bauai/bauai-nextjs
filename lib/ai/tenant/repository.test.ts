import { ObjectId, type Collection } from "mongodb";
import { describe, expect, it } from "vitest";

import { TenantRepository } from "./repository.ts";
import { TenantId, type TenantOwned } from "./types.ts";

interface FakeDoc extends TenantOwned {
  _id?: ObjectId;
  name: string;
}

/**
 * Minimal in-memory stand-in covering the repository's usage of the driver:
 * exact-match filters are enough to prove tenant injection; the real query
 * semantics belong to integration tests.
 */
function fakeCollection(store: FakeDoc[]): Collection<FakeDoc> {
  const matches = (doc: FakeDoc, filter: Record<string, unknown>) =>
    Object.entries(filter).every(([key, value]) => {
      const actual = (doc as unknown as Record<string, unknown>)[key];
      if (actual instanceof ObjectId && value instanceof ObjectId) {
        return actual.equals(value);
      }
      return actual === value;
    });

  return {
    findOne: async (filter: Record<string, unknown>) =>
      store.find((d) => matches(d, filter)) ?? null,
    find: (filter: Record<string, unknown>) => ({
      toArray: async () => store.filter((d) => matches(d, filter)),
    }),
    countDocuments: async (filter: Record<string, unknown>) =>
      store.filter((d) => matches(d, filter)).length,
    insertOne: async (doc: FakeDoc) => {
      const withId = { ...doc, _id: doc._id ?? new ObjectId() };
      store.push(withId);
      return { insertedId: withId._id, acknowledged: true };
    },
    updateOne: async (
      filter: Record<string, unknown>,
      update: { $set?: Record<string, unknown> },
    ) => {
      const target = store.find((d) => matches(d, filter));
      if (target && update.$set) Object.assign(target, update.$set);
      return {
        matchedCount: target ? 1 : 0,
        modifiedCount: target ? 1 : 0,
        acknowledged: true,
      };
    },
    deleteOne: async (filter: Record<string, unknown>) => {
      const index = store.findIndex((d) => matches(d, filter));
      if (index >= 0) store.splice(index, 1);
      return { deletedCount: index >= 0 ? 1 : 0, acknowledged: true };
    },
    deleteMany: async (filter: Record<string, unknown>) => {
      const before = store.length;
      for (let i = store.length - 1; i >= 0; i--) {
        if (matches(store[i], filter)) store.splice(i, 1);
      }
      return { deletedCount: before - store.length, acknowledged: true };
    },
  } as unknown as Collection<FakeDoc>;
}

const tenantA = new ObjectId();
const tenantB = new ObjectId();

function seeded(): { store: FakeDoc[]; repo: TenantRepository<FakeDoc> } {
  const now = new Date();
  const store: FakeDoc[] = [
    { _id: new ObjectId(), tenantId: tenantA, name: "a1", createdAt: now, updatedAt: now },
    { _id: new ObjectId(), tenantId: tenantB, name: "b1", createdAt: now, updatedAt: now },
  ];
  const repo = new TenantRepository(fakeCollection(store), TenantId.of(tenantA));
  return { store, repo };
}

describe("TenantRepository", () => {
  it("scopes an empty filter to the tenant", async () => {
    const { repo } = seeded();
    const docs = await repo.findMany({});
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe("a1");
  });

  it("overwrites a caller-supplied tenantId with its own scope", async () => {
    const { repo } = seeded();
    // Asking for tenant B's data through a tenant-A repo can never yield
    // tenant B documents — the injected scope wins over the filter.
    const doc = await repo.findOne({ tenantId: tenantB } as never);
    expect(doc?.name).not.toBe("b1");
    expect(doc === null || doc.tenantId.equals(tenantA)).toBe(true);
  });

  it("stamps tenantId and timestamps on insert", async () => {
    const { store, repo } = seeded();
    await repo.insertOne({ name: "a2" } as never);
    const inserted = store.find((d) => d.name === "a2");
    expect(inserted?.tenantId.equals(tenantA)).toBe(true);
    expect(inserted?.createdAt).toBeInstanceOf(Date);
  });

  it("cannot update across the tenant boundary", async () => {
    const { store, repo } = seeded();
    const result = await repo.updateOne(
      { name: "b1" },
      { $set: { name: "stolen" } },
    );
    expect(result.matchedCount).toBe(0);
    expect(store.find((d) => d.name === "b1")).toBeDefined();
  });

  it("strips a smuggled tenantId from $set", async () => {
    const { store, repo } = seeded();
    await repo.updateOne(
      { name: "a1" },
      { $set: { name: "renamed", tenantId: tenantB } as never },
    );
    const doc = store.find((d) => d.name === "renamed");
    expect(doc?.tenantId.equals(tenantA)).toBe(true);
  });

  it("deleteMany only touches the tenant's documents", async () => {
    const { store, repo } = seeded();
    const result = await repo.deleteMany({});
    expect(result.deletedCount).toBe(1);
    expect(store).toHaveLength(1);
    expect(store[0].tenantId.equals(tenantB)).toBe(true);
  });
});
