import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));
vi.mock("../../ingestion/db/client.ts", () => ({ getIngestionDb: vi.fn() }));

const { documentThreadKey } = await import("./threads.ts");

describe("Dora thread keys", () => {
  // Checkpoints in agent_checkpoints are keyed by this exact string — a
  // format change silently orphans every existing document conversation. If
  // this test fails, you are breaking checkpoint compatibility, not fixing a
  // bug; the only sanctioned way through is `ai:reset:chat` alongside.
  it("document key format is frozen and disjoint from Clara's namespaces", () => {
    const tenantId = new ObjectId("64a000000000000000000001");
    const documentId = new ObjectId("64a000000000000000000002");
    const key = documentThreadKey(tenantId, documentId);
    expect(key).toBe("dora:64a000000000000000000001:64a000000000000000000002");
    expect(key.startsWith("clara")).toBe(false);
  });
});
