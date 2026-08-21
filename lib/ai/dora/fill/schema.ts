import { z } from "zod";

export const fillDiscoverySchema = z.object({
  fields: z.array(
    z.object({
      nodeId: z.string().min(1).max(160),
      label: z.string().min(1).max(200),
      description: z.string().max(500).default(""),
      required: z.boolean().default(false),
      sensitive: z.boolean().default(false),
      targetText: z.string().max(500).default(""),
      value: z.string().max(20_000).nullable().default(null),
      confidence: z.number().min(0).max(1).default(0),
      evidenceReferences: z.array(z.string().max(300)).max(8).default([]),
      reason: z.string().max(500).default(""),
    }),
  ).max(500),
});

export type FillDiscovery = z.infer<typeof fillDiscoverySchema>;

export const FILL_DISCOVERY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fields"],
  properties: {
    fields: {
      type: "array",
      maxItems: 500,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "nodeId",
          "label",
          "description",
          "required",
          "sensitive",
          "targetText",
          "value",
          "confidence",
          "evidenceReferences",
          "reason",
        ],
        properties: {
          nodeId: { type: "string" },
          label: { type: "string" },
          description: { type: "string" },
          required: { type: "boolean" },
          sensitive: { type: "boolean" },
          targetText: { type: "string" },
          value: { anyOf: [{ type: "string" }, { type: "null" }] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceReferences: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export const fillPatchSchema = z.object({
  fields: z.array(
    z.object({
      id: z.string().min(1).max(200),
      value: z.string().max(20_000).nullable().optional(),
      state: z.enum(["needs_review", "missing", "manual", "not_applicable"]).optional(),
    }),
  ).min(1).max(100),
});
