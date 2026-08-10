import { z } from "zod";

/**
 * Structured output for the match judge — the stage that turns "this tender
 * resembles what you do" into "you can actually win this, and here is why".
 */

/** Bump to invalidate every judged row and force a re-judge. */
export const MATCH_JUDGE_PROMPT_VERSION = "match-j1";

/**
 * Display lengths, enforced by truncation in `judge.ts` — NOT by the schema.
 *
 * These started as hard `.max()` bounds and cost whole batches: the model
 * would write a 65-character concern, zod would reject the response, the
 * retries would fail the same way, and ten tenders would lose their verdict
 * over five characters of chip text. Length is a layout concern; correctness
 * is not worth trading for it.
 */
export const REASON_DISPLAY_MAX = 280;
export const CHIP_DISPLAY_MAX = 60;

/**
 * Hard ceilings, generous on purpose. They exist only to reject genuinely
 * runaway output (a model that starts writing an essay into a chip field),
 * not to police wording.
 */
const REASON_LIMIT = 1200;
const CHIP_LIMIT = 300;

/**
 * `ref` is the tender's position in the batch, not its id. Model-generated
 * ObjectIds are a reliable source of hallucinated or subtly-wrong ids; a small
 * integer can be range-checked, and anything out of range is discarded rather
 * than mapped to the wrong tender.
 */
export const judgedTenderSchema = z.object({
  ref: z.number().int().min(0),
  fitScore: z.number().min(0).max(100),
  confidence: z.enum(["low", "medium", "high"]),
  /**
   * Both languages in one pass. Generating them together costs a few dozen
   * tokens and removes an entire translation stage — and, more importantly,
   * means the German and English reasons can never disagree about the verdict.
   */
  reasonEn: z.string().min(1).max(REASON_LIMIT),
  reasonDe: z.string().min(1).max(REASON_LIMIT),
  /** Short chips: which of the company's capabilities this tender needs. */
  matchedCapabilities: z.array(z.string().min(1).max(CHIP_LIMIT)).max(4),
  /** Short chips: what would stop them winning it. */
  concerns: z.array(z.string().min(1).max(CHIP_LIMIT)).max(3),
});

export type JudgedTender = z.infer<typeof judgedTenderSchema>;

/**
 * No `.max()` on `results` — deliberately.
 *
 * Gemini's `responseJsonSchema` rejects `maxItems` on a TOP-LEVEL array
 * property with a bare "Request contains an invalid argument", while happily
 * accepting it on nested arrays (hence the caps inside `judgedTenderSchema`
 * are fine). Every batch failed on this before it was found, so leave it off.
 *
 * Nothing is lost: `judgeCandidates` discards any `ref` the batch was not
 * offered and keeps only the first verdict per ref, which bounds the usable
 * result count at the batch size regardless of what comes back.
 */
export const matchJudgeBatchSchema = z.object({
  results: z.array(judgedTenderSchema),
});

export type MatchJudgeBatch = z.infer<typeof matchJudgeBatchSchema>;

export const MATCH_JUDGE_JSON_SCHEMA = z.toJSONSchema(matchJudgeBatchSchema, {
  target: "draft-7",
}) as Record<string, unknown>;
