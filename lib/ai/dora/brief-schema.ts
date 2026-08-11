import { z } from "zod";

export const DORA_BRIEF_PROMPT_VERSION = "dora-brief-p1";

/**
 * Model output for the Document Brief. Citations are BY REFERENCE, exactly
 * like the verdict (§ verdict/schema.ts): the model may only point at
 * evidence IDs from the server-built table (E* extraction citations,
 * R* tender chunks, C* company chunks); the server resolves them and DROPS
 * unknown IDs, so a fabricated citation cannot survive.
 *
 * The content is generated in TWO calls (analysis + action plan) and
 * translated per language afterwards — empirically, gemini-3.5-flash's
 * structured-output validator rejects schemas with more than ~4
 * array-of-object properties with a bare 400 ("Request contains an invalid
 * argument"), so the full brief cannot be one declaration. Never merge these
 * schemas into one model call. (No `.nullable()` anywhere for the same
 * reason: JSON-Schema null unions are also rejected.)
 */

const evidenceIds = z
  .array(z.string())
  .max(4)
  .describe("IDs from the evidence table supporting this item; [] if none covers it");

/** Call 1: what the document is, what it demands, what is unclear. */
export const briefAnalysisSchema = z.object({
  documentType: z
    .string()
    .describe(
      "What kind of document this is, in the reader's terms — e.g. 'Leistungsverzeichnis', 'Eigenerklärung (self-declaration form)', 'price sheet'",
    ),
  purpose: z
    .string()
    .describe("One sentence: what this document is FOR in the tender/bid process"),
  summary: z.string().describe("2-4 sentences: what the document contains and its role"),
  keyRequirements: z
    .array(z.object({ text: z.string(), evidenceIds }))
    .max(12)
    .describe("Requirements this document states or implies for the bidder"),
  deadlines: z
    .array(
      z.object({
        label: z.string(),
        date: z
          .string()
          .describe("ISO date/datetime when determinable, else an empty string"),
        evidenceIds,
      }),
    )
    .max(8),
  missingInfo: z
    .array(z.string())
    .max(10)
    .describe("What could not be determined and must be clarified by a human"),
  risks: z
    .array(
      z.object({
        text: z.string(),
        severity: z.enum(["low", "medium", "high"]),
        evidenceIds,
      }),
    )
    .max(8),
});

/** Call 2: what the user should DO with the document. */
export const briefPlanSchema = z.object({
  requiredActions: z
    .array(
      z.object({
        step: z.string().describe("Short imperative step title"),
        detail: z.string().describe("What exactly to do, concrete and practical"),
        evidenceIds,
      }),
    )
    .max(12)
    .describe("Ordered checklist: what the user must DO with this document"),
  suggestedValues: z
    .array(
      z.object({
        field: z.string().describe("The field/blank in the document, as named there"),
        value: z.string().describe("The exact value to enter"),
        source: z
          .enum(["document", "tender", "company"])
          .describe("Where the value comes from"),
        evidenceIds,
      }),
    )
    .max(16)
    .describe("Concrete fill-in values the user can copy into the document"),
});

/** One language's full brief content, as STORED (analysis + plan merged). */
export const briefContentSchema = briefAnalysisSchema.extend(briefPlanSchema.shape);

export type BriefAnalysis = z.infer<typeof briefAnalysisSchema>;
export type BriefPlan = z.infer<typeof briefPlanSchema>;
export type BriefContent = z.infer<typeof briefContentSchema>;

export const ANALYSIS_JSON_SCHEMA = z.toJSONSchema(briefAnalysisSchema, {
  target: "draft-7",
}) as Record<string, unknown>;

export const PLAN_JSON_SCHEMA = z.toJSONSchema(briefPlanSchema, {
  target: "draft-7",
}) as Record<string, unknown>;
