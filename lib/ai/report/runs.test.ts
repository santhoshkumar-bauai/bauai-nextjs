import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { TenderReportRunDocument } from "../types.ts";

/**
 * Claim and staleness semantics — the rules that make the report page
 * resumable: one run per tender, a reload rejoins it, and a run whose process
 * died can be retried instead of blocking forever.
 */

const findOne = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();

vi.mock("../db/collections.ts", () => ({
  getAiCollections: async () => ({
    tenderReportRuns: { findOne, findOneAndUpdate, updateOne },
  }),
}));

const { claimRun, getRun, finishRun } = await import("./runs.ts");

const tenantId = new ObjectId();
const tenderId = new ObjectId();

function runDoc(overrides: Partial<TenderReportRunDocument> = {}) {
  const now = new Date();
  return {
    _id: new ObjectId(),
    tenantId,
    tenderId,
    status: "running" as const,
    stage: "analyzing" as const,
    locale: "de" as const,
    startedByUserId: "user-1",
    error: null,
    startedAt: now,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  findOne.mockReset();
  findOneAndUpdate.mockReset();
  updateOne.mockReset();
});

describe("getRun", () => {
  it("returns a live run as-is", async () => {
    findOne.mockResolvedValue(runDoc());
    const run = await getRun(tenantId, tenderId);
    expect(run?.status).toBe("running");
    expect(run?.stage).toBe("analyzing");
  });

  it("reports a run whose heartbeat stopped as failed", async () => {
    // The process that owned this run died mid-generation.
    findOne.mockResolvedValue(
      runDoc({ updatedAt: new Date(Date.now() - 10 * 60_000) }),
    );
    const run = await getRun(tenantId, tenderId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("failed");
  });

  it("returns null when nothing has ever run", async () => {
    findOne.mockResolvedValue(null);
    expect(await getRun(tenantId, tenderId)).toBeNull();
  });
});

describe("claimRun", () => {
  it("claims when nothing is running", async () => {
    findOneAndUpdate.mockResolvedValue(runDoc({ stage: "gathering" }));
    const claimed = await claimRun({
      tenantId,
      tenderId,
      locale: "de",
      userId: "user-1",
    });
    expect(claimed?.stage).toBe("gathering");

    // The filter must only match a free or dead run — never steal a live one.
    const [filter] = findOneAndUpdate.mock.calls[0];
    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0]).toEqual({ status: { $ne: "running" } });
    expect(filter.$or[1].updatedAt.$lt).toBeInstanceOf(Date);
  });

  it("refuses when another run holds the claim", async () => {
    // Filter matched nothing, the upsert collided with the unique index.
    findOneAndUpdate.mockRejectedValue(
      Object.assign(new Error("E11000 duplicate key"), { code: 11000 }),
    );
    expect(
      await claimRun({ tenantId, tenderId, locale: "en", userId: "user-2" }),
    ).toBeNull();
  });

  it("propagates failures that are not the claim race", async () => {
    findOneAndUpdate.mockRejectedValue(new Error("connection lost"));
    await expect(
      claimRun({ tenantId, tenderId, locale: "en", userId: "user-2" }),
    ).rejects.toThrow("connection lost");
  });
});

describe("finishRun", () => {
  it("marks success", async () => {
    await finishRun({ tenantId, tenderId, error: null });
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.status).toBe("done");
    expect(update.$set.error).toBeNull();
    expect(update.$set.finishedAt).toBeInstanceOf(Date);
  });

  it("records the failure code", async () => {
    await finishRun({ tenantId, tenderId, error: "rate_limited" });
    const [, update] = updateOne.mock.calls[0];
    expect(update.$set.status).toBe("failed");
    expect(update.$set.error).toBe("rate_limited");
  });
});
