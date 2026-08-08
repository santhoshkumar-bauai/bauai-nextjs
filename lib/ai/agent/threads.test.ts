import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));
vi.mock("../../ingestion/db/client.ts", () => ({ getIngestionDb: vi.fn() }));

const collections = await import("../db/collections.ts");
const { getOwnedThread, globalThreadKey, tenderThreadKey } = await import(
  "./threads.ts"
);

describe("thread keys", () => {
  // Checkpoints in agent_checkpoints are keyed by these exact strings — a
  // format change silently orphans every existing conversation. If this test
  // fails, you are breaking checkpoint compatibility, not fixing a bug.
  it("tender key format is frozen", () => {
    const tenantId = new ObjectId("64a000000000000000000001");
    const tenderId = new ObjectId("64a000000000000000000002");
    expect(tenderThreadKey(tenantId, tenderId)).toBe(
      "dora:64a000000000000000000001:64a000000000000000000002",
    );
  });

  it("global key derives from the thread id and cannot collide with tender keys", () => {
    const threadId = new ObjectId("64a000000000000000000003");
    const key = globalThreadKey(threadId);
    expect(key).toBe("dorag:64a000000000000000000003");
    expect(key.startsWith("dora:")).toBe(false);
  });
});

describe("getOwnedThread", () => {
  const tenantId = new ObjectId();
  const threadId = new ObjectId();

  function mockThread(thread: Record<string, unknown> | null) {
    vi.mocked(collections.getAiCollections).mockResolvedValue({
      chatThreads: { findOne: vi.fn(async () => thread) },
    } as never);
  }

  it("hides global threads from non-owners, serves them to the owner", async () => {
    mockThread({ _id: threadId, tenantId, kind: "global", ownerUserId: "alice" });
    expect(
      await getOwnedThread({ tenantId, userId: "bob", threadId }),
    ).toBeNull();
    expect(
      await getOwnedThread({ tenantId, userId: "alice", threadId }),
    ).not.toBeNull();
  });

  it("serves tender threads to any company member", async () => {
    mockThread({ _id: threadId, tenantId, kind: "tender", ownerUserId: null });
    expect(
      await getOwnedThread({ tenantId, userId: "anyone", threadId }),
    ).not.toBeNull();
  });
});
