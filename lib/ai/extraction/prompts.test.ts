import { describe, expect, it } from "vitest";

import { buildExtractionPrompt, buildRetryPrompt } from "./prompts.ts";
import { EXTRACTION_SCHEMAS } from "./schemas/index.ts";

const blocks = [
  {
    kind: "chunk" as const,
    chunkId: "665f00aa",
    sectionPath: ["1. Fristen"],
    text: "Die Angebotsfrist endet am 27.08.2026.",
  },
  {
    kind: "document" as const,
    documentRecordId: "proc:x#abc",
    fileName: "BVB.pdf",
    text: "§ 11 Vertragsstrafen ...",
  },
];

describe("buildExtractionPrompt", () => {
  it("renders chunk ids, section paths, and document headers", () => {
    const prompt = buildExtractionPrompt({
      schema: EXTRACTION_SCHEMAS.deadlines,
      blocks,
    });
    expect(prompt).toContain("[chunk:665f00aa] (1. Fristen)");
    expect(prompt).toContain("[document:proc:x#abc] BVB.pdf");
    expect(prompt).toContain('"deadlines"');
    expect(prompt).toContain("Fristen");
    expect(prompt).toContain("invented value is a defect");
  });
});

describe("buildRetryPrompt", () => {
  it("names only the failed fields and demands verbatim copying", () => {
    const prompt = buildRetryPrompt({
      schema: EXTRACTION_SCHEMAS.deadlines,
      failedFieldNames: ["submissionDeadline"],
      blocks,
    });
    expect(prompt).toContain("ONLY these fields");
    expect(prompt).toContain("submissionDeadline");
    expect(prompt).toContain("CHARACTER-FOR-CHARACTER");
  });
});
