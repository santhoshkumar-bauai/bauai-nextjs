import type { ObjectId } from "mongodb";

import { logger } from "../../ingestion/observability/logger.ts";
import type { TenderAgentRunContext } from "../agent/context.ts";
import type { ChatCitation } from "../agent/citations.ts";
import type { WireVerdict } from "../agent/wire.ts";
import { getAiCollections } from "../db/collections.ts";
import { getExtractions, computeCorpusHash } from "../extraction/store.ts";
import { getFitState, companyProfileInput } from "../fit/service.ts";
import { hashCompanyData, listEmbeddedCompanyDocs } from "../fit/company-hash.ts";
import { resolveRole } from "../gateway/config.ts";
import { getTenderOverview } from "../overview/service.ts";
import { hybridRetrieveChunks } from "../retrieval/hybrid.ts";
import type { TenderVerdictDocument } from "../types.ts";
import { getAgentChatModel } from "../agent/model.ts";
import {
  buildEvidenceTable,
  buildVerdictPrompt,
  type EvidenceTable,
} from "./prompt.ts";
import {
  DORA_VERDICT_PROMPT_VERSION,
  VERDICT_JSON_SCHEMA,
  verdictOutputSchema,
  type VerdictOutput,
} from "./schema.ts";

const log = logger.child("ai.verdict");

const GAP_RETRIEVAL_K = 6;

function resolveCitations(
  evidenceIds: string[],
  table: EvidenceTable,
): ChatCitation[] {
  // Unknown IDs are dropped — the model cannot invent a citation object.
  return evidenceIds
    .map((id) => table.byId.get(id))
    .filter((citation): citation is ChatCitation => citation != null);
}

export function serializeVerdict(
  doc: TenderVerdictDocument,
  stale: boolean,
): WireVerdict {
  return {
    id: String(doc._id),
    recommendation: doc.recommendation,
    rationale: doc.rationale,
    scoreBreakdown: doc.scoreBreakdown,
    risks: doc.risks.map((risk) => ({
      text: risk.text,
      severity: risk.severity,
      citations: risk.citations as unknown as WireVerdict["risks"][number]["citations"],
      uncited: risk.uncited,
    })),
    blockingRequirements: doc.blockingRequirements.map((requirement) => ({
      text: requirement.text,
      citations:
        requirement.citations as unknown as WireVerdict["blockingRequirements"][number]["citations"],
    })),
    unresolvedQuestions: doc.unresolvedQuestions,
    stale,
    locale: doc.locale,
    generatedAt: doc.updatedAt.toISOString(),
  };
}

export async function getVerdictState(
  ctx: TenderAgentRunContext,
): Promise<{ verdict: TenderVerdictDocument; stale: boolean } | null> {
  const { tenderVerdicts } = await getAiCollections();
  const doc = await tenderVerdicts.findOne({
    tenantId: ctx.tenantId,
    tenderId: ctx.tender.tenderId,
  });
  if (!doc) return null;

  const corpusHash = await computeCorpusHash(ctx.tender.tenderId);
  const companyDataHash = hashCompanyData(
    companyProfileInput(ctx.companyContext.company),
    await listEmbeddedCompanyDocs(ctx.tenantId),
  );
  const stale =
    doc.inputs.corpusHash !== corpusHash ||
    doc.inputs.companyDataHash !== companyDataHash ||
    doc.model.promptVersion !== DORA_VERDICT_PROMPT_VERSION;
  return { verdict: doc, stale };
}

/**
 * Generates the verdict: deterministic evidence assembly → one structured
 * model call → server-side citation resolution → replace-wholesale persist.
 */
export async function generateVerdict(input: {
  ctx: TenderAgentRunContext;
  threadId: ObjectId | null;
  onProgress?: (stage: "loading_artifacts" | "retrieving_gaps" | "drafting") => void;
}): Promise<TenderVerdictDocument> {
  const { ctx } = input;

  input.onProgress?.("loading_artifacts");
  const [extractions, overviewRecord, fitState] = await Promise.all([
    getExtractions(ctx.tender.tenderId),
    getTenderOverview(ctx.tender.tenderId),
    getFitState(ctx.companyContext, ctx.tender.tenderId),
  ]);

  input.onProgress?.("retrieving_gaps");
  const weakSchemas = extractions.filter(
    (extraction) => extraction.status === "EMPTY" || extraction.status === "PARTIAL",
  );
  const gapChunks =
    weakSchemas.length > 0 || extractions.length === 0
      ? await hybridRetrieveChunks({
          text: "Eignung Nachweise Vertragsstrafen Fristen Zuschlagskriterien besondere Bedingungen",
          mode: "hybrid",
          k: GAP_RETRIEVAL_K,
          filters: { tenantId: null, tenderId: ctx.tender.tenderId },
        }).catch(() => [])
      : [];

  const evidence = buildEvidenceTable(extractions, gapChunks);
  const overview = overviewRecord?.overview as
    | Record<string, Record<string, unknown>>
    | undefined;
  const overviewContent = overview?.[ctx.locale] ?? overview?.en;
  const overviewText = overviewContent
    ? [overviewContent.about, overviewContent.requirements, overviewContent.risks]
        .filter(Boolean)
        .map((section) =>
          typeof section === "string" ? section : JSON.stringify(section),
        )
        .join("\n")
        .slice(0, 4000)
    : null;

  const prompt = buildVerdictPrompt({
    ctx,
    extractions,
    overviewText,
    fit: fitState.recommendation
      ? { recommendation: fitState.recommendation, stale: fitState.stale }
      : null,
    evidence,
  });

  input.onProgress?.("drafting");
  const model = await getAgentChatModel({ maxOutputTokens: 4096 });
  const structured = model.withStructuredOutput<VerdictOutput>(
    VERDICT_JSON_SCHEMA as never,
    { name: "tender_verdict" },
  );
  const raw = await structured.invoke(prompt);
  const output = verdictOutputSchema.parse(raw);

  const corpusHash = await computeCorpusHash(ctx.tender.tenderId);
  const companyDataHash = hashCompanyData(
    companyProfileInput(ctx.companyContext.company),
    await listEmbeddedCompanyDocs(ctx.tenantId),
  );
  const modelRef = resolveRole("agent");
  const now = new Date();

  const doc: Omit<TenderVerdictDocument, "_id" | "createdAt"> = {
    tenantId: ctx.tenantId,
    tenderId: ctx.tender.tenderId,
    threadId: input.threadId,
    messageId: null,
    agentRunId: null,
    recommendation: output.recommendation,
    rationale: output.rationale,
    scoreBreakdown: output.scoreBreakdown,
    risks: output.risks.map((risk) => {
      const citations = resolveCitations(risk.evidenceIds, evidence);
      return {
        text: risk.text,
        severity: risk.severity,
        citations: citations as unknown as Array<Record<string, unknown>>,
        ...(citations.length === 0 ? { uncited: true } : {}),
      };
    }),
    blockingRequirements: output.blockingRequirements.map((requirement) => ({
      text: requirement.text,
      citations: resolveCitations(
        requirement.evidenceIds,
        evidence,
      ) as unknown as Array<Record<string, unknown>>,
    })),
    unresolvedQuestions: output.unresolvedQuestions,
    inputs: {
      corpusHash,
      companyDataHash,
      extractionStatuses: Object.fromEntries(
        extractions.map((extraction) => [extraction.schemaName, extraction.status]),
      ),
      fitGeneratedAt: fitState.generatedAt,
    },
    model: {
      provider: modelRef.provider,
      providerModel: modelRef.model,
      promptVersion: DORA_VERDICT_PROMPT_VERSION,
    },
    review: { state: "PENDING", reviewerId: null, reviewedAt: null, edits: [] },
    locale: ctx.locale,
    updatedAt: now,
  };

  const { tenderVerdicts } = await getAiCollections();
  await tenderVerdicts.updateOne(
    { tenantId: ctx.tenantId, tenderId: ctx.tender.tenderId },
    { $set: doc, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  const stored = await tenderVerdicts.findOne({
    tenantId: ctx.tenantId,
    tenderId: ctx.tender.tenderId,
  });

  log.info("verdict generated", {
    tenderId: String(ctx.tender.tenderId),
    recommendation: output.recommendation,
    risks: output.risks.length,
  });
  return stored as TenderVerdictDocument;
}
