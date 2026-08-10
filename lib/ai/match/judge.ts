import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { resolveRole } from "../gateway/config.ts";
import { getGateway } from "../gateway/index.ts";
import { buildMatchJudgePrompt, type JudgeCandidate } from "./prompt.ts";
import {
  CHIP_DISPLAY_MAX,
  MATCH_JUDGE_JSON_SCHEMA,
  MATCH_JUDGE_PROMPT_VERSION,
  matchJudgeBatchSchema,
  REASON_DISPLAY_MAX,
  type JudgedTender,
} from "./schema.ts";

/**
 * Judges the head of the fused candidate list against the company profile.
 *
 * Failure is isolated per batch on purpose: a rate limit or a malformed
 * response for ten tenders must not discard the other 190, and an unjudged
 * tender keeps its retrieval score rather than being pushed down the feed
 * (see `finalScore`). Degrading to "no reason shown" is acceptable; losing
 * real matches is not.
 */

const log = logger.child("ai.match.judge");

export interface JudgeResult {
  /** Verdicts by candidate `ref`. Absent for anything a failed batch dropped. */
  byRef: Map<number, JudgedTender>;
  batches: { total: number; failed: number };
  model: { provider: string; providerModel: string } | null;
}

/** Trim to a display length at a word boundary, rather than mid-word. */
function clamp(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Enforce display lengths here, where overrunning costs nothing. */
function toDisplayLengths(verdict: JudgedTender): JudgedTender {
  return {
    ...verdict,
    reasonEn: clamp(verdict.reasonEn, REASON_DISPLAY_MAX),
    reasonDe: clamp(verdict.reasonDe, REASON_DISPLAY_MAX),
    matchedCapabilities: verdict.matchedCapabilities.map((chip) =>
      clamp(chip, CHIP_DISPLAY_MAX),
    ),
    concerns: verdict.concerns.map((chip) => clamp(chip, CHIP_DISPLAY_MAX)),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/** Runs `tasks` with at most `limit` in flight, preserving result order. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

async function judgeBatch(
  companyContext: string,
  candidates: JudgeCandidate[],
): Promise<{ verdicts: JudgedTender[]; failed: boolean }> {
  const validRefs = new Set(candidates.map((candidate) => candidate.ref));

  try {
    const result = await getGateway().generateStructured({
      role: "match",
      prompt: buildMatchJudgePrompt({ companyContext, candidates }),
      schema: MATCH_JUDGE_JSON_SCHEMA,
      zod: matchJudgeBatchSchema,
      // Judgements must be reproducible: the same company and the same tender
      // should not move up and down the feed between refreshes.
      temperature: 0,
    });

    // Defensive: drop refs the batch was never offered, and keep only the
    // first verdict per ref. The model reorders and occasionally duplicates;
    // neither may be allowed to attach a verdict to the wrong tender.
    const seen = new Set<number>();
    const verdicts = result.value.results
      .filter((verdict) => {
        if (!validRefs.has(verdict.ref) || seen.has(verdict.ref)) return false;
        seen.add(verdict.ref);
        return true;
      })
      .map(toDisplayLengths);

    return { verdicts, failed: false };
  } catch (error) {
    log.warn("judge batch failed, leaving its tenders unjudged", {
      size: candidates.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { verdicts: [], failed: true };
  }
}

export async function judgeCandidates(input: {
  companyContext: string;
  candidates: JudgeCandidate[];
  onProgress?: (done: number, total: number) => void;
}): Promise<JudgeResult> {
  const env = aiEnv();
  const byRef = new Map<number, JudgedTender>();

  if (input.candidates.length === 0) {
    return { byRef, batches: { total: 0, failed: 0 }, model: null };
  }

  const batches = chunk(input.candidates, env.matchJudgeBatch);
  let done = 0;
  let failed = 0;

  const outcomes = await mapWithConcurrency(
    batches,
    env.matchJudgeConcurrency,
    async (batch) => {
      const outcome = await judgeBatch(input.companyContext, batch);
      done += 1;
      input.onProgress?.(done, batches.length);
      return outcome;
    },
  );

  for (const outcome of outcomes) {
    if (outcome.failed) failed += 1;
    for (const verdict of outcome.verdicts) byRef.set(verdict.ref, verdict);
  }

  const role = resolveRole("match");
  log.info("judged candidates", {
    candidates: input.candidates.length,
    judged: byRef.size,
    batches: batches.length,
    failedBatches: failed,
    promptVersion: MATCH_JUDGE_PROMPT_VERSION,
  });

  return {
    byRef,
    batches: { total: batches.length, failed },
    model: { provider: role.provider, providerModel: role.model },
  };
}
