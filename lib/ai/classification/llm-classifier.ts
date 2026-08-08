import { z } from "zod";

import { getGateway } from "../gateway/index.ts";
import {
  DOC_CLASSES,
  DOC_CLASS_MEANINGS,
  docClassSchema,
  type DocClass,
} from "./doc-classes.ts";

/** Fallback for files no heuristic rule recognizes. */

const resultSchema = z.object({
  docClass: docClassSchema,
  confidence: z.number().min(0).max(1),
});

export interface LlmClassification {
  docClass: DocClass;
  confidence: number;
  model: string;
}

const EXCERPT_CHARS = 2000;

export async function classifyWithModel(input: {
  fileName: string;
  excerpt: string;
}): Promise<LlmClassification> {
  const classListing = DOC_CLASSES.map(
    (docClass) => `- ${docClass}: ${DOC_CLASS_MEANINGS[docClass]}`,
  ).join("\n");

  const prompt = [
    "Classify this German public-tender document into exactly one class.",
    "The documents are German; the class identifiers are English.",
    'Use "unknown" when genuinely undeterminable — do not guess.',
    "",
    "Classes:",
    classListing,
    "",
    `Filename: ${input.fileName}`,
    "Document text (beginning):",
    input.excerpt.slice(0, EXCERPT_CHARS),
  ].join("\n");

  const result = await getGateway().generateStructured({
    role: "extraction",
    prompt,
    temperature: 0,
    schema: {
      type: "object",
      properties: {
        docClass: { type: "string", enum: [...DOC_CLASSES] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
      required: ["docClass", "confidence"],
      additionalProperties: false,
    },
    zod: resultSchema,
  });

  return {
    docClass: result.value.docClass,
    confidence: result.value.confidence,
    model: result.model,
  };
}
