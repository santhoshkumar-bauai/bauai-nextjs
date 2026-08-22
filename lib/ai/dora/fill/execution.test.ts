import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dispatchDocumentFillTask,
  documentFillExecutionMode,
  fillGenerationDisposition,
  fillRequiresQueueMode,
  pdfInlineMaxBytes,
} from "./execution.ts";

describe("fillRequiresQueueMode", () => {
  const MB = 1024 * 1024;

  it("never applies to Word, whose analysis sends a snapshot not a file", () => {
    expect(fillRequiresQueueMode({ format: "docx", sizeBytes: 500 * MB, mode: "inline" })).toBe(
      false,
    );
  });

  it("lets a small PDF run inline", () => {
    expect(fillRequiresQueueMode({ format: "pdf", sizeBytes: MB, mode: "inline" })).toBe(false);
  });

  it("refuses a large PDF in inline mode", () => {
    expect(fillRequiresQueueMode({ format: "pdf", sizeBytes: 5 * MB, mode: "inline" })).toBe(true);
  });

  it("has no ceiling in queue mode, the supported production setting", () => {
    expect(fillRequiresQueueMode({ format: "pdf", sizeBytes: 500 * MB, mode: "queue" })).toBe(
      false,
    );
  });

  it("honours a configured ceiling", () => {
    expect(
      fillRequiresQueueMode({ format: "pdf", sizeBytes: 3 * MB, mode: "inline", maxBytes: 8 * MB }),
    ).toBe(false);
  });

  it("falls back to 2 MiB for a missing or nonsense ceiling", () => {
    expect(pdfInlineMaxBytes(undefined)).toBe(2 * MB);
    expect(pdfInlineMaxBytes("not-a-number")).toBe(2 * MB);
    expect(pdfInlineMaxBytes("0")).toBe(2 * MB);
    expect(pdfInlineMaxBytes("4194304")).toBe(4 * MB);
  });
});

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
