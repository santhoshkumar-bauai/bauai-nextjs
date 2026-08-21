import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchDocumentFillTask,
  documentFillExecutionMode,
  fillGenerationDisposition,
} from "./execution.ts";

const originalMode = process.env.ONLYOFFICE_FILL_EXECUTION_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.ONLYOFFICE_FILL_EXECUTION_MODE;
  else process.env.ONLYOFFICE_FILL_EXECUTION_MODE = originalMode;
});

describe("document fill execution", () => {
  it("runs inline by default without touching the queue", async () => {
    delete process.env.ONLYOFFICE_FILL_EXECUTION_MODE;
    const inline = vi.fn(async () => undefined);
    const queued = vi.fn(async () => undefined);

    await expect(dispatchDocumentFillTask({ inline, queued })).resolves.toBe("inline");
    expect(inline).toHaveBeenCalledOnce();
    expect(queued).not.toHaveBeenCalled();
  });

  it("uses the queue only when explicitly enabled", async () => {
    process.env.ONLYOFFICE_FILL_EXECUTION_MODE = "queue";
    const inline = vi.fn(async () => undefined);
    const queued = vi.fn(async () => undefined);

    await expect(dispatchDocumentFillTask({ inline, queued })).resolves.toBe("queue");
    expect(queued).toHaveBeenCalledOnce();
    expect(inline).not.toHaveBeenCalled();
  });

  it("rejects invalid execution modes instead of silently changing behavior", () => {
    expect(() => documentFillExecutionMode("background")).toThrow(
      /Expected "inline" or "queue"/,
    );
  });

  it("treats repeat generation of an already completed run as idempotent", () => {
    expect(fillGenerationDisposition({ status: "completed" })).toBe("completed");
    expect(fillGenerationDisposition({ status: "review" })).toBe("generate");
    expect(fillGenerationDisposition({ status: "analyzing" })).toBe("review_required");
    expect(fillGenerationDisposition(null)).toBe("review_required");
  });
});
