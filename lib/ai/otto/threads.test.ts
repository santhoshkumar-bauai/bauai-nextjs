import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";

vi.mock("../db/collections.ts", () => ({ getAiCollections: vi.fn() }));

const { onboardingThreadKey } = await import("./threads.ts");

describe("Otto thread keys", () => {
  // Checkpoints in agent_checkpoints are keyed by this exact string — a format
  // change silently orphans every in-progress onboarding. If this test fails,
  // you are breaking checkpoint compatibility, not fixing a bug; the only
  // sanctioned way through is `ai:reset:chat` alongside.
  it("onboarding key format is frozen and disjoint from Clara's and Dora's", () => {
    const tenantId = new ObjectId("64a000000000000000000001");
    const key = onboardingThreadKey(tenantId, "user_abc123");

    expect(key).toBe("otto:64a000000000000000000001:user_abc123");
    expect(key.startsWith("clara")).toBe(false);
    expect(key.startsWith("dora")).toBe(false);
  });

  it("is scoped per user, so colleagues do not share one tour", () => {
    const tenantId = new ObjectId("64a000000000000000000001");

    expect(onboardingThreadKey(tenantId, "user_a")).not.toBe(
      onboardingThreadKey(tenantId, "user_b"),
    );
  });
});
