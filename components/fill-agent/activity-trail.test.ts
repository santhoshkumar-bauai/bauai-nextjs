import { describe, expect, it } from "vitest";

import type { FillActivityEvent } from "@/lib/ai/fill-agent/workflow-wire";
import { groupTrail, summariseBatch } from "./activity-trail";

/**
 * The repair loop emits crop → review → patch → refill → rescore per attempt,
 * and the run-wide budget allows forty of them. Rendered flat that is a couple
 * of hundred near-identical rows repeating the same page range, which is what
 * made the trail unreadable. The batch is the unit a person wants to see.
 */

let cursor = 0;
function event(patch: Partial<FillActivityEvent>): FillActivityEvent {
  cursor += 1;
  return {
    cursor,
    at: "2026-08-26T12:00:00.000Z",
    action: "repair_region",
    status: "completed",
    batchId: null,
    pageStart: null,
    pageEnd: null,
    message: "step",
    ...patch,
  };
}

function attempt(batchId: string, score: number, issues: number): FillActivityEvent[] {
  return [
    event({ batchId, pageStart: 1, pageEnd: 2, action: "crop_issues", message: "Rendering crops" }),
    event({ batchId, pageStart: 1, pageEnd: 2, action: "repair_region", message: "Applied patch" }),
    event({ batchId, pageStart: 1, pageEnd: 2, action: "fill_repair_batch", message: "Regenerated" }),
    event({
      batchId, pageStart: 1, pageEnd: 2, action: "validate_repair_batch",
      message: "Repair batch score", score, remainingIssues: issues,
    }),
  ];
}

describe("workflow trail grouping", () => {
  it("collapses a repair batch's attempts into one row", () => {
    const events = [
      event({ action: "map_document", message: "Mapped 42 fields" }),
      event({ action: "fill_document", message: "Filled the complete PDF" }),
      ...attempt("repair-pages-1-2", 0, 8),
      ...attempt("repair-pages-1-2", 0.4, 6),
      event({ action: "assemble_document", message: "Rebuilt the document" }),
    ];

    const rows = groupTrail(events);
    // Two document steps + ONE batch + the rebuild — not eight repair rows.
    expect(rows.map((row) => row.kind)).toEqual(["step", "step", "batch", "step"]);
    const batch = rows[2];
    if (batch.kind !== "batch") throw new Error("expected a batch row");
    expect(batch.events).toHaveLength(8);
    expect(batch.pageStart).toBe(1);
    expect(batch.pageEnd).toBe(2);
  });

  it("keeps separate batches apart", () => {
    const rows = groupTrail([
      ...attempt("repair-pages-1-4", 0, 3),
      ...attempt("repair-pages-5-8", 0, 2),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === "batch")).toBe(true);
  });

  it("summarises a batch as attempts, score movement and what is left", () => {
    const summary = summariseBatch([
      ...attempt("repair-pages-1-2", 0, 8),
      ...attempt("repair-pages-1-2", 0.4, 6),
    ]);
    expect(summary.attempts).toBe(2);
    expect(summary.scores).toEqual([0, 0.4]);
    expect(summary.remainingIssues).toBe(6);
    expect(summary.needsReview).toBe(false);
  });

  it("carries a paused batch's state up to the collapsed row", () => {
    // Otherwise the one thing worth seeing is hidden behind the toggle.
    const summary = summariseBatch([
      ...attempt("repair-pages-1-2", 0, 8),
      event({
        batchId: "repair-pages-1-2", pageStart: 1, pageEnd: 2,
        action: "repair_region", status: "paused", message: "review limit",
      }),
    ]);
    expect(summary.needsReview).toBe(true);
  });

  it("leaves document-level steps ungrouped", () => {
    const rows = groupTrail([
      event({ action: "inspect_document", message: "Inspected 2 pages" }),
      event({ action: "verify_placement", message: "Visual check added 3 issues" }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["step", "step"]);
  });
});
