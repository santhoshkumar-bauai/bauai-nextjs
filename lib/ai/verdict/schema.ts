import { z } from "zod";

export const DORA_VERDICT_PROMPT_VERSION = "vd-p1";

/**
 * Model output for the verdict (roadmap §20.3). Citations are BY REFERENCE:
 * the model may only point at evidence IDs from the server-built evidence
 * table (E1…, R1…); the server resolves them to real citations and DROPS
 * unknown IDs — a fabricated citation cannot survive.
 */
const score = z.number().min(0).max(1);

export const verdictOutputSchema = z.object({
  recommendation: z.enum(["bid", "no_bid", "conditional"]),
  rationale: z
    .string()
    .describe("One paragraph: the decisive reasons for the recommendation"),
  scoreBreakdown: z.object({
    eligibilityFit: score.describe("Can the company plausibly satisfy the eligibility requirements?"),
    strategicFit: score.describe("Does the work match what the company does and wants?"),
    capacityFit: score.describe("Size/volume vs the company's scale"),
    contractRisk: score.describe("1 = low risk. Penalties, terms, unknowns lower this"),
    deadlineFeasibility: score.describe("Is a quality bid feasible before the deadline?"),
  }),
  risks: z
    .array(
      z.object({
        text: z.string(),
        severity: z.enum(["low", "medium", "high"]),
        evidenceIds: z.array(z.string()).describe("IDs from the evidence table supporting this risk"),
      }),
    )
    .max(10),
  blockingRequirements: z
    .array(
      z.object({
        text: z.string(),
        evidenceIds: z.array(z.string()),
      }),
    )
    .max(8)
    .describe("Requirements that MUST be satisfied or the bid is invalid"),
  unresolvedQuestions: z
    .array(z.string())
    .max(8)
    .describe("What a human must clarify before bidding"),
});

export type VerdictOutput = z.infer<typeof verdictOutputSchema>;

export const VERDICT_JSON_SCHEMA = z.toJSONSchema(verdictOutputSchema, {
  target: "draft-7",
}) as Record<string, unknown>;
