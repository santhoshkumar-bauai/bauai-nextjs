import type { ObjectId } from "mongodb";

import { hybridRetrieveChunks } from "../retrieval/hybrid.ts";
import type { RetrievalMode, RetrievedChunk } from "../retrieval/types.ts";
import { CANONICAL_QUESTIONS, type CanonicalQuestion } from "./questions.ts";

/**
 * Retrieval evaluation over the canonical questions (§17.5). Grades a chunk
 * as relevant when the question's expectation matches; reports hit@1/5/10 and
 * MRR per mode and language. This is the regression baseline every retrieval
 * or embedding change must be measured against (§31.4).
 */

export interface QuestionResult {
  questionId: string;
  language: "de" | "en";
  mode: RetrievalMode;
  tenderId: string;
  firstRelevantRank: number | null;
  retrieved: number;
  latencyMs: number;
}

export interface EvalSummary {
  mode: RetrievalMode;
  language: "de" | "en";
  questions: number;
  answerable: number;
  hitAt1: number;
  hitAt5: number;
  hitAt10: number;
  mrr: number;
  meanLatencyMs: number;
}

export function chunkMatches(
  question: CanonicalQuestion,
  chunk: RetrievedChunk,
): boolean {
  if (question.expectation.type === "legalRef") {
    return question.expectation.patterns.some((ref) =>
      chunk.legalRefs.includes(ref),
    );
  }
  return question.expectation.patterns.some((pattern) =>
    new RegExp(pattern, "i").test(chunk.text),
  );
}

export async function runQuestion(input: {
  question: CanonicalQuestion;
  language: "de" | "en";
  mode: RetrievalMode;
  tenderId: ObjectId;
  tenantId: ObjectId | null;
  k: number;
}): Promise<QuestionResult> {
  const started = Date.now();
  const chunks = await hybridRetrieveChunks({
    text: input.language === "de" ? input.question.de : input.question.en,
    mode: input.mode,
    k: input.k,
    filters: { tenantId: input.tenantId, tenderId: input.tenderId },
  });
  const latencyMs = Date.now() - started;

  let firstRelevantRank: number | null = null;
  for (const chunk of chunks) {
    if (chunkMatches(input.question, chunk)) {
      firstRelevantRank = chunk.rank;
      break;
    }
  }

  return {
    questionId: input.question.id,
    language: input.language,
    mode: input.mode,
    tenderId: String(input.tenderId),
    firstRelevantRank,
    retrieved: chunks.length,
    latencyMs,
  };
}

/**
 * A question is only gradeable on a tender whose corpus can answer it at all
 * (a package without insurance clauses cannot "fail" the insurance question).
 * Answerability = any chunk of the tender matches the expectation — checked
 * with a direct scan, independent of retrieval quality.
 */
export async function answerableQuestions(
  tenderId: ObjectId,
): Promise<Set<string>> {
  const { getAiCollections } = await import("../db/collections.ts");
  const { chunks } = await getAiCollections();
  const rows = await chunks
    .find({ tenderId }, { projection: { text: 1, legalRefs: 1 } })
    .toArray();

  const answerable = new Set<string>();
  for (const question of CANONICAL_QUESTIONS) {
    const matches = rows.some((row) =>
      chunkMatches(question, {
        text: row.text,
        legalRefs: row.legalRefs,
      } as RetrievedChunk),
    );
    if (matches) answerable.add(question.id);
  }
  return answerable;
}

export function summarize(
  results: QuestionResult[],
  mode: RetrievalMode,
  language: "de" | "en",
): EvalSummary {
  const relevant = results.filter(
    (r) => r.mode === mode && r.language === language,
  );
  const answerable = relevant.length;
  const hits = (k: number) =>
    relevant.filter((r) => r.firstRelevantRank !== null && r.firstRelevantRank < k)
      .length;
  const mrr =
    answerable === 0
      ? 0
      : relevant.reduce(
          (sum, r) =>
            sum + (r.firstRelevantRank === null ? 0 : 1 / (r.firstRelevantRank + 1)),
          0,
        ) / answerable;

  return {
    mode,
    language,
    questions: relevant.length,
    answerable,
    hitAt1: answerable ? hits(1) / answerable : 0,
    hitAt5: answerable ? hits(5) / answerable : 0,
    hitAt10: answerable ? hits(10) / answerable : 0,
    mrr,
    meanLatencyMs:
      answerable === 0
        ? 0
        : Math.round(
            relevant.reduce((sum, r) => sum + r.latencyMs, 0) / relevant.length,
          ),
  };
}
