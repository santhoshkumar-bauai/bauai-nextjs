import { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { buildProfileTerms, hasUsableTerms } from "../../tenders/profile-terms.ts";
import { buildRelevancePipeline } from "../../tenders/relevance.ts";
import { rankTendersByProfileText } from "../../tenders/text-arm.ts";
import { getCompanyFilesCollection } from "../company/doc-embedder.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import {
  buildFullCompanyContext,
  type CompanyContextInput,
} from "../fit/company-context.ts";
import type { CompanyMatchProfileDocument, TenderMatchScoreDocument } from "../types.ts";
import {
  buildMatchProfile,
  embeddingIdentity,
  getCompaniesCollection,
  getMatchProfileState,
  toCompanyContext,
} from "./company-profile.ts";
import { resolveCpvNameMap, resolveCpvNames } from "./cpv.ts";
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
  textScore: number;
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
  textRankedIds?: ObjectId[];
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
      textRankedIds: input.textRankedIds,
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
 * Uploaded files for the judge's "Documents on file" section — with the
 * opening of each document's extracted text, joined from the profile facets
 * that already carry it. The excerpt is what lets the judge see that a file
 * named "Abbenrode_Anbau_Feuerwehr.docx" describes electrical/TGA work; a
 * bare filename proved to be worth nothing (the judge scored every tender
 * the documents matched at fit≤20 for "wrong trade").
 *
 * Logos prove nothing about capability and are skipped; insurance stays —
 * for the judge it is eligibility evidence, even though it is excluded from
 * retrieval facets.
 */
async function listJudgeDocuments(
  tenantId: ObjectId,
  profile: CompanyMatchProfileDocument,
): Promise<Array<{ fileName: string; category: string; excerpt?: string }>> {
  try {
    const excerpts = new Map<string, string>(
      profile.facets
        .filter((facet) => facet.kind === "document")
        .map((facet) => [facet.key, facet.text]),
    );
    const companyFiles = await getCompanyFilesCollection();
    const rows = await companyFiles
      .find({ companyId: tenantId, category: { $ne: "logo" } })
      .project<{ _id: ObjectId; fileName: string; category: string }>({
        fileName: 1,
        category: 1,
      })
      .limit(12)
      .toArray();
    return rows.map((row) => ({
      fileName: row.fileName,
      category: row.category,
      excerpt: excerpts.get(`doc:company:${row._id.toHexString()}`),
    }));
  } catch {
    return [];
  }
}

/**
 * Human-readable retrieval provenance for one candidate — the judge's
 * "Matched via" line. Facet labels first (strongest evidence first is already
 * the `matchedFacets` order), then the deterministic arms.
 */
function matchedViaLabels(
  candidate: { matchedFacets: Array<{ key: string; kind: string; label: string | null }> },
  arms: { fromRuleArm: boolean; fromTextArm: boolean },
): string[] {
  const labels = candidate.matchedFacets.map((facet) => {
    if (facet.kind === "document") {
      return `uploaded document: ${facet.label ?? "unnamed"}`;
    }
    if (facet.key.startsWith("reference:")) {
      return `reference project: ${facet.label ?? "unnamed"}`;
    }
    if (facet.key === "qualifications") return "company qualifications";
    return "company capabilities";
  });
  if (arms.fromTextArm) labels.push("notice text matches your services");
  if (arms.fromRuleArm) labels.push("CPV/region ranking");
  return labels;
}

/**
 * The notice-text arm for the AI matcher: the company's services, trades and
 * specializations run as a lexical search against what each notice actually
 * says (`sx_tenders`). This is the arm that reaches a tender whose CPV codes
 * are missing or wrong — the case the whole services-first change exists for —
 * and it needs no uploads and no embeddings, so it works from the first
 * refresh after signup.
 *
 * Deliberately NOT `lib/tenders/profile-text-rank.ts`: that wrapper pulls in
 * `@/`-aliased modules and the Next.js Mongo client, neither of which survives
 * the BullMQ worker's strip-types loader. Same building blocks, worker-safe
 * plumbing.
 *
 * Best-effort by contract: a thin profile or a deployment without Atlas
 * Search degrades to an empty arm, never a failed refresh.
 */
async function runTextArm(
  company: CompanyContextInput,
  profile: CompanyMatchProfileDocument,
): Promise<ObjectId[]> {
  const terms = await buildProfileTerms(company).catch(() => []);
  if (!hasUsableTerms(terms)) return [];

  const nutsCodes = [profile.scope.nuts.nuts2, profile.scope.nuts.nuts1].filter(
    (code): code is string => Boolean(code),
  );

  try {
    const db = await getIngestionDb();
    return await rankTendersByProfileText(db, terms, {
      countries: profile.scope.countries,
      nutsCodes,
    });
  } catch (error) {
    if (isSearchUnavailable(error)) return [];
    throw error;
  }
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

    // One read serves the text arm, the judge context and the doc listing.
    const companies = await getCompaniesCollection();
    const companyRow = await companies.findOne({ _id: tenantId });
    const companyContextInput = companyRow ? toCompanyContext(companyRow) : null;

    // ---- 2. retrieval ----------------------------------------------------
    await markStage(tenantId, "retrieving");
    const [facetHits, ruleRows, textRankedIds] = await Promise.all([
      retrieveByFacets(profile),
      runRelevance({ profile, now, limit: RULE_ARM_DEPTH }),
      companyContextInput
        ? runTextArm(companyContextInput, profile)
        : Promise.resolve<ObjectId[]>([]),
    ]);

    // ---- 3. fusion -------------------------------------------------------
    await markStage(tenantId, "fusing");
    const candidates = fuseCandidates({
      facetHits,
      ruleRankedIds: ruleRows.map((row) => row._id.toHexString()),
      textRankedIds: textRankedIds.map((id) => id.toHexString()),
      poolCap: env.matchPoolCap,
      weights: { ruleArm: env.matchRuleArmWeight, textArm: env.matchTextArmWeight },
    });

    if (candidates.length === 0) {
      await publishRun({ tenantId, runId, scoredCount: 0, judgedCount: 0 });
      return { scoredCount: 0, judgedCount: 0, facetCount: profile.facets.length };
    }

    // Re-score the fused pool through the shared pipeline. This is also what
    // re-verifies status/isVisible/deadline against `tenders` — the vector
    // index's `filters.*` are a snapshot from embedding time and can lag.
    // `textRankedIds` goes into this call only, NOT the rule-arm call above:
    // the text ranking already votes as its own RRF arm, and letting it also
    // reshape the rule arm would count one signal twice.
    const scored = await runRelevance({
      profile,
      now,
      limit: candidates.length,
      includeIds: candidates.map((candidate) => new ObjectId(candidate.tenderId)),
      textRankedIds,
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

    // The judge sees the company as capabilities-first prose: CPV codes
    // resolved to names, and the uploaded files listed as evidence. Both are
    // best-effort — a failed lookup degrades to the raw profile.
    const [companyCpvNames, companyDocuments] = companyContextInput
      ? await Promise.all([
          resolveCpvNames(companyContextInput.cpvCodes ?? []).catch(
            () => [] as string[],
          ),
          listJudgeDocuments(tenantId, profile),
        ])
      : [[], []];

    const companyContext = companyContextInput
      ? buildFullCompanyContext({
          ...companyContextInput,
          cpvNames: companyCpvNames,
          documents: companyDocuments,
        })
      : "";

    const cpvNames = await resolveCpvNameMap(
      ranked.flatMap(({ row }) => row.cpvCodes ?? []),
    );

    // Retrieval provenance per candidate — which arms actually surfaced it.
    const ruleIdSet = new Set(ruleRows.map((row) => row._id.toHexString()));
    const textIdSet = new Set(textRankedIds.map((id) => id.toHexString()));

    const judgeCandidateList: JudgeCandidate[] = ranked.map(
      ({ row, candidate }, index) => ({
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
        matchedVia: matchedViaLabels(candidate, {
          fromRuleArm: ruleIdSet.has(candidate.tenderId),
          fromTextArm: textIdSet.has(candidate.tenderId),
        }),
      }),
    );

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
          text: row.textScore,
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
