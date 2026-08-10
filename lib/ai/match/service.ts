import { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { buildRelevancePipeline } from "../../tenders/relevance.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { buildFullCompanyContext } from "../fit/company-context.ts";
import type { CompanyMatchProfileDocument, TenderMatchScoreDocument } from "../types.ts";
import {
  buildMatchProfile,
  embeddingIdentity,
  getCompaniesCollection,
  getMatchProfileState,
  toCompanyContext,
} from "./company-profile.ts";
import { resolveCpvNameMap } from "./cpv.ts";
import { finalScore, fuseCandidates, matchScore } from "./fusion.ts";
import { judgeCandidates } from "./judge.ts";
import type { JudgeCandidate } from "./prompt.ts";
import { isSearchUnavailable, retrieveByFacets } from "./retrieve.ts";
import { MATCH_JUDGE_PROMPT_VERSION } from "./schema.ts";
import {
  heartbeat,
  markProgress,
  markStage,
  publishRun,
  RUN_HEARTBEAT_MS,
} from "./runs.ts";

/**
 * The AI match refresh: profile → semantic retrieval → fusion with the
 * deterministic ranking → persisted rows.
 *
 * Phase 1 stops before judging; `judgedCount` stays 0 and `fitScore` stays
 * null, which `finalScore` handles by falling through to the retrieval score.
 */

const log = logger.child("ai.match.service");

/** Deterministic ranking depth used as the rule arm of the fusion. */
const RULE_ARM_DEPTH = 200;

/** The projected shape of `buildRelevancePipeline`'s `items` branch. */
interface ScoredRow {
  _id: ObjectId;
  score: number;
  cpvScore: number;
  geoScore: number;
  timeScore: number;
  title?: string | null;
  description?: string | null;
  buyer?: { name?: string | null } | null;
  cpvCodes?: string[];
  regions?: string[];
  submissionDeadline?: Date | null;
  estimatedValueAmount?: string | null;
  estimatedValueCurrency?: string | null;
  contractNature?: string | null;
  procedureType?: string | null;
}

/**
 * Run the classic relevance pipeline and return the scored rows.
 *
 * Called twice per refresh with different intents: once without `includeIds`
 * to obtain the company's deterministic ranking (the rule arm), and once with
 * `includeIds` to score the fused candidate pool using the very same
 * cpv/geo/time expressions the classic feed uses. Sharing the pipeline is the
 * point — the two feeds can never disagree about what "CPV-relevant" means.
 */
async function runRelevance(input: {
  profile: CompanyMatchProfileDocument;
  now: Date;
  limit: number;
  includeIds?: ObjectId[];
}): Promise<ScoredRow[]> {
  const db = await getIngestionDb();
  const { pipeline } = buildRelevancePipeline(
    {
      companyCpvCodes: input.profile.scope.cpvCodes,
      nuts: { ...input.profile.scope.nuts, source: "nuts-code" },
      countries: input.profile.scope.countries,
      companyPoint: null,
    },
    {
      now: input.now,
      page: 0,
      pageSize: input.limit,
      rankCap: input.limit,
      includeIds: input.includeIds,
    },
  );

  const [facet] = await db
    .collection("tenders")
    .aggregate<{ items: ScoredRow[] }>(pipeline, { allowDiskUse: true })
    .toArray();
  return facet?.items ?? [];
}

export interface RefreshResult {
  scoredCount: number;
  judgedCount: number;
  facetCount: number;
}

/**
 * Rebuild a company's AI matches end to end.
 *
 * Deliberately takes no AbortSignal: a user closing the tab must not throw
 * away work that has already been paid for in embedding and LLM calls. The
 * run document is the only progress channel.
 */
export async function refreshCompanyMatches(input: {
  tenantId: ObjectId;
  runId: ObjectId;
}): Promise<RefreshResult> {
  const { tenantId, runId } = input;
  const env = aiEnv();
  const now = new Date();

  const beat = setInterval(() => {
    void heartbeat(tenantId).catch(() => {});
  }, RUN_HEARTBEAT_MS);

  try {
    // ---- 1. profile ------------------------------------------------------
    await markStage(tenantId, "building_profile");
    const state = await getMatchProfileState(tenantId);
    const profile = state.stale ? await buildMatchProfile(tenantId) : state.profile;
    if (!profile) throw new Error("match profile could not be built");

    // ---- 2. retrieval ----------------------------------------------------
    await markStage(tenantId, "retrieving");
    const [facetHits, ruleRows] = await Promise.all([
      retrieveByFacets(profile),
      runRelevance({ profile, now, limit: RULE_ARM_DEPTH }),
    ]);

    // ---- 3. fusion -------------------------------------------------------
    await markStage(tenantId, "fusing");
    const candidates = fuseCandidates({
      facetHits,
      ruleRankedIds: ruleRows.map((row) => row._id.toHexString()),
      poolCap: env.matchPoolCap,
    });

    if (candidates.length === 0) {
      await publishRun({ tenantId, runId, scoredCount: 0, judgedCount: 0 });
      return { scoredCount: 0, judgedCount: 0, facetCount: profile.facets.length };
    }

    // Re-score the fused pool through the shared pipeline. This is also what
    // re-verifies status/isVisible/deadline against `tenders` — the vector
    // index's `filters.*` are a snapshot from embedding time and can lag.
    const scored = await runRelevance({
      profile,
      now,
      limit: candidates.length,
      includeIds: candidates.map((candidate) => new ObjectId(candidate.tenderId)),
    });
    const scoredById = new Map(scored.map((row) => [row._id.toHexString(), row]));

    const maxFused = candidates[0]?.fused ?? 0;
    const survivors = candidates.filter((candidate) => scoredById.has(candidate.tenderId));

    const ranked = survivors
      .map((candidate) => {
        const row = scoredById.get(candidate.tenderId);
        if (!row) throw new Error("unreachable: filtered above");
        return {
          candidate,
          row,
          match: matchScore({
            fused: candidate.fused,
            maxFused,
            geoScore: row.geoScore,
            timeScore: row.timeScore,
          }),
        };
      })
      .sort((a, b) => b.match - a.match)
      .slice(0, env.matchRankCap);

    // ---- 4. judge --------------------------------------------------------
    // Retrieval is good at "is this the same kind of work". Only this stage
    // can see "they want a certified asbestos handler and you are not one".
    await markStage(tenantId, "judging");
    // Publish the batch count up front so the progress panel shows "0 of 20"
    // rather than "0 of 0" until the first batch lands.
    await markProgress(tenantId, {
      done: 0,
      total: Math.ceil(ranked.length / env.matchJudgeBatch),
    });

    const companies = await getCompaniesCollection();
    const companyRow = await companies.findOne({ _id: tenantId });
    const companyContext = companyRow
      ? buildFullCompanyContext(toCompanyContext(companyRow))
      : "";

    const cpvNames = await resolveCpvNameMap(
      ranked.flatMap(({ row }) => row.cpvCodes ?? []),
    );

    const judgeCandidateList: JudgeCandidate[] = ranked.map(({ row }, index) => ({
      ref: index,
      title: row.title ?? null,
      buyerName: row.buyer?.name ?? null,
      categories: [
        ...new Set(
          (row.cpvCodes ?? []).flatMap((code) => {
            const name = cpvNames.get(code);
            return name ? [name] : [];
          }),
        ),
      ],
      regions: row.regions ?? [],
      submissionDeadline: row.submissionDeadline
        ? new Date(row.submissionDeadline).toISOString().slice(0, 10)
        : null,
      estimatedValue: row.estimatedValueAmount
        ? `${row.estimatedValueAmount} ${row.estimatedValueCurrency ?? ""}`.trim()
        : null,
      contractNature: row.contractNature ?? null,
      procedureType: row.procedureType ?? null,
      description: row.description ?? null,
    }));

    const judged = companyContext
      ? await judgeCandidates({
          companyContext,
          candidates: judgeCandidateList,
          onProgress: (done, total) => {
            void markProgress(tenantId, { done, total }).catch(() => {});
          },
        })
      : { byRef: new Map(), batches: { total: 0, failed: 0 }, model: null };

    // ---- 5. persist ------------------------------------------------------
    await markStage(tenantId, "finalizing");
    const { tenderMatchScores } = await getAiCollections();
    const identity = embeddingIdentity();

    // The judge reorders the feed, so `rank` is assigned after it runs — the
    // stored rank must agree with what the user actually sees.
    const docs = ranked
      .map(({ candidate, row, match }, index) => {
        const verdict = judged.byRef.get(index);
        return {
          row,
          candidate,
          match,
          verdict,
          final: finalScore(match, verdict?.fitScore ?? null),
        };
      })
      .sort((a, b) => b.final - a.final);

    const writes = docs.map(({ candidate, row, match, verdict, final }, rank) => {
      const doc: Omit<TenderMatchScoreDocument, "createdAt"> = {
        tenantId,
        tenderId: row._id,
        runId,
        rank,
        matchScore: match,
        fitScore: verdict?.fitScore ?? null,
        finalScore: final,
        confidence: verdict?.confidence ?? null,
        signals: {
          semantic: candidate.semantic,
          semanticRaw: candidate.semanticRaw,
          rule: row.score,
          cpv: row.cpvScore,
          geo: row.geoScore,
          time: row.timeScore,
          fused: candidate.fused,
        },
        matchedFacets: candidate.matchedFacets,
        reasons: verdict ? { en: verdict.reasonEn, de: verdict.reasonDe } : null,
        matchedCapabilities: verdict?.matchedCapabilities ?? [],
        concerns: verdict?.concerns ?? [],
        companyDataHash: profile.companyDataHash,
        promptVersion: MATCH_JUDGE_PROMPT_VERSION,
        pipelineVersion: env.matchPipelineVersion,
        embeddingIdentity: identity,
        model: judged.model,
        computedAt: now,
        updatedAt: now,
      };
      return {
        updateOne: {
          filter: { tenantId, tenderId: row._id },
          update: { $set: doc, $setOnInsert: { createdAt: now } },
          upsert: true,
        },
      };
    });

    if (writes.length > 0) {
      await tenderMatchScores.bulkWrite(writes, { ordered: false });
    }

    // Flip the pointer only now: readers were on the previous run's rows for
    // this whole function, so the feed changes in one step.
    await publishRun({
      tenantId,
      runId,
      scoredCount: ranked.length,
      judgedCount: judged.byRef.size,
    });

    log.info("refreshed company matches", {
      tenantId: tenantId.toHexString(),
      facets: profile.facets.length,
      candidates: candidates.length,
      scored: ranked.length,
      judged: judged.byRef.size,
      failedBatches: judged.batches.failed,
    });

    return {
      scoredCount: ranked.length,
      judgedCount: judged.byRef.size,
      facetCount: profile.facets.length,
    };
  } finally {
    clearInterval(beat);
  }
}

/** Collapse a thrown error to the i18n key the UI renders. Never raw text. */
export function toRunError(error: unknown): string {
  if (isSearchUnavailable(error)) return "search_unavailable";
  const name = error instanceof Error ? error.name : "";
  if (name === "RateLimitError") return "rate_limited";
  return "failed";
}
