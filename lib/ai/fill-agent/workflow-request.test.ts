import { describe, expect, it } from "vitest";

import {
  fillWorkflowRequestSchema,
  MAX_WORKFLOW_INPUT_ITEMS,
} from "./workflow-request.ts";

describe("fillWorkflowRequestSchema", () => {
  it("accepts a document-wide resume with more than 60 decision groups", () => {
    const decisions = Array.from({ length: 62 }, (_, index) => ({
      groupId: `decision-${index}`,
      fieldId: `field-${index}`,
    }));

    expect(fillWorkflowRequestSchema.safeParse({
      action: "resume",
      values: [],
      decisions,
    }).success).toBe(true);
  });

  it("retains a finite document-level request budget", () => {
    const decisions = Array.from({ length: MAX_WORKFLOW_INPUT_ITEMS + 1 }, (_, index) => ({
      groupId: `decision-${index}`,
      fieldId: `field-${index}`,
    }));

    expect(fillWorkflowRequestSchema.safeParse({
      action: "resume",
      values: [],
      decisions,
    }).success).toBe(false);
  });
});
