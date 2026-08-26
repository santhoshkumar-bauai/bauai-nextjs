import { afterEach, describe, expect, it } from "vitest";

import { resetFillAgentEnvForTests } from "./env.ts";
import { fillPatchSchema } from "./fieldmap.ts";
import { assertLocalizedPatch } from "./planner.ts";
import {
  buildDecisionGroups,
  fillWorkflowRecursionLimit,
  repairBatchesForIssues,
  retainExistingValues,
  SupersededFillRunError,
} from "./workflow-graph.ts";
import {
  emptyFillWorkflow,
  workflowOwnsDocument,
  type FillWorkflowStatus,
} from "./workflow-wire.ts";

describe("adaptive fill workflow", () => {
  afterEach(() => {
    delete process.env.AI_FILL_AGENT_MAX_REPAIR_ATTEMPTS;
    resetFillAgentEnvForTests();
  });

  it("keeps the superstep budget above what the repair loop can schedule", () => {
    // The repair loop costs four supersteps per attempt and one freeze per
    // batch; the run-wide repair budget is what makes that finite. A limit
    // below the worst case is the GraphRecursionError this replaced.
    for (const pageCount of [1, 4, 25, 50]) {
      const maxBatches = Math.ceil(pageCount / 4);
      const worstCase = 9 + 2 + 40 * 4 + maxBatches;
      expect(fillWorkflowRecursionLimit(pageCount)).toBeGreaterThan(worstCase);
    }
  });

  it("scales the superstep budget with the repair budget instead of a constant", () => {
    const atDefault = fillWorkflowRecursionLimit(25);
    process.env.AI_FILL_AGENT_MAX_REPAIR_ATTEMPTS = "80";
    resetFillAgentEnvForTests();
    expect(fillWorkflowRecursionLimit(25)).toBe(atDefault + 40 * 4);
  });

  it("names the superseded run and the one that replaced it", () => {
    // A retry bumps runId onto a fresh checkpoint thread while the previous
    // run is still executing; its next persist stops it rather than
    // interleaving writes into the new run's session state.
    const error = new SupersededFillRunError(2, 3);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("SupersededFillRunError");
    expect(error.message).toMatch(/run 2 was superseded by run 3/);
  });

  it("gives the workflow exclusive ownership only while a run is live", () => {
    const owned: FillWorkflowStatus[] = [
      "inspecting", "mapping", "awaiting_input", "filling", "repairing", "assembling",
    ];
    for (const status of owned) {
      expect(workflowOwnsDocument({ ...emptyFillWorkflow(), status })).toBe(true);
    }
    // `queued` = never started (the editor panel never starts one) and the
    // two terminal states hand the document back to the chat agent.
    for (const status of ["queued", "completed", "needs_review"] as FillWorkflowStatus[]) {
      expect(workflowOwnsDocument({ ...emptyFillWorkflow(), status })).toBe(false);
    }
    expect(workflowOwnsDocument(null)).toBe(false);
    expect(workflowOwnsDocument(undefined)).toBe(false);
  });

  it("starts each new workflow on a durable run id with no assumed company context", () => {
    expect(emptyFillWorkflow()).toMatchObject({ runId: 1, companyContext: null });
  });
  it("creates four-page batches only for pages with post-fill errors", () => {
    const strategies25 = Array.from({ length: 25 }, () => "digital" as const);
    const batches25 = repairBatchesForIssues(25, strategies25, [
      { severity: "error", code: "OVERFLOW_X", field_id: "p1", page: 1, detail: "overflow" },
      { severity: "error", code: "BOX_TOO_SMALL", field_id: "p2", page: 2, detail: "small" },
      { severity: "error", code: "ANCHOR_MISMATCH", field_id: "p25", page: 25, detail: "anchor" },
      { severity: "warning", code: "FONT", field_id: "p9", page: 9, detail: "warning only" },
    ]);
    expect(batches25).toHaveLength(2);
    expect(batches25[0]).toMatchObject({ id: "repair-pages-1-4", pageStart: 1, pageEnd: 4 });
    expect(batches25.at(-1)).toMatchObject({ pageStart: 25, pageEnd: 25 });

    const strategies50 = Array.from({ length: 50 }, () => "digital" as const);
    expect(repairBatchesForIssues(50, strategies50, [])).toEqual([]);
    expect(repairBatchesForIssues(50, strategies50, [
      { severity: "error", code: "OFF_PAGE", field_id: "p50", page: 50, detail: "off page" },
    ]).at(-1)).toMatchObject({ pageStart: 49, pageEnd: 50 });
  });

  it("models legal Ja/Nein fields as one required decision", () => {
    const groups = buildDecisionGroups(
      [
        { id: "insolvenz_ja", page: 2, kind: "checkbox", box: [10, 10, 20, 20], label: "Insolvenz: Ja", required: true },
        { id: "insolvenz_nein", page: 2, kind: "checkbox", box: [30, 10, 40, 20], label: "Insolvenz: Nein", required: true },
      ],
      [],
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ required: true, sensitive: true, selection: null });
    expect(groups[0].options.map((option) => option.fieldId)).toEqual(["insolvenz_ja", "insolvenz_nein"]);
  });

  it("rejects crop repair mutations outside local fields and anchors", () => {
    expect(() => assertLocalizedPatch(
      { update: [{ id: "page_9_field", anchorId: "p9:cell:x" }], add: [], remove: [] },
      1,
      new Set(["page_1_field"]),
      new Set(["p1:cell:a"]),
    )).toThrow(/outside its crop/);

    expect(() => assertLocalizedPatch(
      { update: [{ id: "page_1_field", box: [1, 2, 3, 4] }], add: [], remove: [] },
      1,
      new Set(["page_1_field"]),
      new Set(["p1:cell:a"]),
    )).toThrow(/arbitrary coordinates/);

    expect(() => assertLocalizedPatch(
      { update: [{ id: "page_1_field", anchorId: "p1:cell:a" }], add: [], remove: [] },
      1,
      new Set(["page_1_field"]),
      new Set(["p1:cell:a"]),
    )).not.toThrow();
  });

  it("lets a repair move a value to another entry on ITS OWN page", () => {
    // The destination of a misplaced value is by definition outside the crop it
    // landed in. Restricting anchors to the crop made misplacement structurally
    // unfixable: three attempts, then review.
    const pageAnchors = new Set(["p1:cell:a", "p1:empty_box:elsewhere"]);
    expect(() => assertLocalizedPatch(
      { update: [{ id: "page_1_field", anchorId: "p1:empty_box:elsewhere" }], add: [], remove: [] },
      1,
      new Set(["page_1_field"]),
      pageAnchors,
    )).not.toThrow();

    // Everything else still holds.
    expect(() => assertLocalizedPatch(
      { update: [{ id: "page_1_field", anchorId: "p2:cell:other_page" }], add: [], remove: [] },
      1,
      new Set(["page_1_field"]),
      pageAnchors,
    )).toThrow(/outside its page/);
    expect(() => assertLocalizedPatch(
      { update: [], add: [{ id: "invented", page: 1, kind: "text", box: [1, 2, 3, 4], label: "" }], remove: [] },
      1,
      new Set(["page_1_field"]),
      pageAnchors,
    )).toThrow(/may not add ungrounded fields/);
  });

  it("does not inject full-field coordinate defaults into anchor-only repairs", () => {
    const patch = fillPatchSchema.parse({
      update: [{ id: "page_1_field", anchorId: "p1:cell:a" }],
    });

    expect(patch.update[0]).not.toHaveProperty("box");
    expect(patch.update[0]).not.toHaveProperty("label");
    expect(() => assertLocalizedPatch(
      patch,
      1,
      new Set(["page_1_field"]),
      new Set(["p1:cell:a"]),
    )).not.toThrow();
  });

  it("retains legacy user values when geometry v2 changes the field id", () => {
    const result = retainExistingValues(
      [{ id: "company_name_v2", page: 1, kind: "text", box: [48, 90, 540, 103], label: "Company name" }],
      [{ id: "company_name", page: 1, kind: "text", box: [48, 90, 52.32, 102], label: "Company name", value: "Wirl Ing (dev)" }],
      { company_name: "Wirl Ing (dev)" },
    );
    expect(result.fields[0].value).toBe("Wirl Ing (dev)");
    expect(result.values.company_name_v2).toBe("Wirl Ing (dev)");
  });
});
