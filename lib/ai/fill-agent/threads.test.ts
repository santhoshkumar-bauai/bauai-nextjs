import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));
vi.mock("../../ingestion/db/client.ts", () => ({ getIngestionDb: vi.fn() }));

const { fillSessionThreadKey } = await import("./threads.ts");

describe("fill-agent thread keys", () => {
  // Checkpoints in agent_checkpoints are keyed by this exact string — a
  // format change orphans every ongoing fill conversation. If this test
  // fails you are breaking checkpoint compatibility, not fixing a bug.
  it("key format is frozen and disjoint from clara/dora/otto namespaces", () => {
    const tenantId = new ObjectId("64a000000000000000000001");
    const sessionId = new ObjectId("64a000000000000000000002");
    const key = fillSessionThreadKey(tenantId, sessionId);
    expect(key).toBe("fillagent:64a000000000000000000001:64a000000000000000000002");
    for (const foreign of ["clara", "clarag", "dora", "otto"]) {
      expect(key.startsWith(`${foreign}:`)).toBe(false);
    }
  });
});
