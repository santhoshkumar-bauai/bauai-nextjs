import { describe, expect, it } from "vitest";

import { aiOperationRequestSchema, aiProposalSchema } from "./ai-schema";

describe("structured Clara document operations", () => {
  it("accepts bounded, hash-addressed proposals", () => {
    const proposal = aiProposalSchema.parse({
      operations: [{
        id: "op-1",
        target: { kind: "selection", expectedHash: "12345678" },
        action: "replace",
        value: "Updated text",
        rationale: "Matches the tender requirement.",
        confidence: 0.9,
        citations: [{ sourceId: "e1", label: "Requirements.docx" }],
      }],
    });
    expect(proposal.operations).toHaveLength(1);
  });

  it("rejects missing target hashes and excessive confidence", () => {
    expect(aiProposalSchema.safeParse({ operations: [{
      id: "op-1", target: { kind: "selection" }, action: "replace",
      value: "x", rationale: "x", confidence: 2, citations: [],
    }] }).success).toBe(false);
  });

  it("bounds editor context", () => {
    const result = aiOperationRequestSchema.safeParse({
      documentId: "doc",
      task: "rewrite",
      instruction: "rewrite",
      context: { selection: "x".repeat(30_001), items: [] },
    });
    expect(result.success).toBe(false);
  });
});
