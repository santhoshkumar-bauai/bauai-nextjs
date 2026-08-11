import { z } from "zod";

export const aiTaskSchema = z.enum(["prefill", "rewrite", "review"]);

const contextItemSchema = z.object({
  id: z.string().min(1).max(200),
  value: z.string().max(20_000),
  expectedHash: z.string().min(8).max(128),
  label: z.string().max(500).optional(),
  sheet: z.string().max(200).optional(),
  range: z.string().max(100).optional(),
});

export const aiOperationRequestSchema = z.object({
  documentId: z.string().min(1),
  task: aiTaskSchema,
  instruction: z.string().max(5_000).default(""),
  context: z.object({
    selection: z.string().max(30_000).optional(),
    selectionHash: z.string().min(8).max(128).optional(),
    items: z.array(contextItemSchema).max(250).default([]),
  }),
});

const targetSchema = z.object({
  kind: z.enum(["selection", "contentControl", "form", "cellRange", "pdfForm", "textAnchor"]),
  id: z.string().max(200).optional(),
  sheet: z.string().max(200).optional(),
  range: z.string().max(100).optional(),
  expectedHash: z.string().min(8).max(128),
  before: z.string().max(500).optional(),
  target: z.string().max(5_000).optional(),
  after: z.string().max(500).optional(),
  occurrence: z.number().int().min(0).optional(),
});

export const aiProposalSchema = z.object({
  operations: z.array(
    z.object({
      id: z.string().min(1).max(100),
      target: targetSchema,
      action: z.enum(["replace", "setForm", "setCell", "comment"]),
      value: z.string().max(30_000),
      rationale: z.string().max(2_000),
      confidence: z.number().min(0).max(1),
      citations: z.array(
        z.object({
          sourceId: z.string().min(1).max(200),
          label: z.string().min(1).max(500),
          quote: z.string().max(500).optional(),
        }),
      ).max(10),
    }),
  ).max(100),
});

export type AiOperationRequest = z.infer<typeof aiOperationRequestSchema>;
export type AiProposal = z.infer<typeof aiProposalSchema>;
