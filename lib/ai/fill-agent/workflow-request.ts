import { z } from "zod";

/**
 * A workflow can map up to 1,200 fields, so a single human-in-the-loop
 * resume must be able to confirm the corresponding document-wide values and
 * decision groups. Keeping this aligned with fillPlanSchema avoids rejecting
 * valid large forms (the ESPD regression has 62 decision groups).
 */
export const MAX_WORKFLOW_INPUT_ITEMS = 1_200;

export const fillWorkflowRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("retry") }),
  z.object({
    action: z.literal("resume"),
    values: z
      .array(z.object({
        fieldId: z.string().min(1).max(80),
        value: z.string().max(2_000),
      }))
      .max(MAX_WORKFLOW_INPUT_ITEMS)
      .default([]),
    decisions: z
      .array(z.object({
        groupId: z.string().min(1).max(200),
        fieldId: z.string().min(1).max(80),
      }))
      .max(MAX_WORKFLOW_INPUT_ITEMS)
      .default([]),
  }),
]);
