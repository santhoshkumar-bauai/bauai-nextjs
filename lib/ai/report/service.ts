import type { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import type { SerializedTenderDetail } from "../../tenders/detail.ts";
import type { ChatCitation } from "../agent/citations.ts";
import { getChatModel } from "../agent/model.ts";
import { getAiCollections } from "../db/collections.ts";
import { computeCorpusHash } from "../extraction/store.ts";
import { hashCompanyData, listEmbeddedCompanyDocs } from "../fit/company-hash.ts";
import { companyProfileInput } from "../fit/service.ts";
import { resolveRole } from "../gateway/config.ts";
import { forCompanyContext } from "../tenant/repository.ts";
import type { TenderReportDocument } from "../types.ts";
import { buildReportContext } from "./context.ts";
import {
  buildTranslationPrompt,
  REPORT_JSON_SCHEMA,
  REPORT_LOCALES,
  REPORT_PROMPT_VERSION,
  reportSchema,
  type ReportLocale,
  type TenderReportContent,
} from "./schema.ts";

const log = logger.child("ai.report");

/** The steps the UI shows while a report is being written. */
export type ReportStage = "gathering" | "analyzing" | "translating" | "saving";

export interface ReportState {
  report: TenderReportDocument;
  stale: boolean;
}

/** The evidence IDs the model actually referenced, resolved to citations. */
function collectReferencedIds(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectReferencedIds(entry, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "evidenceIds" && Array.isArray(child)) {
        for (const id of child) if (typeof id === "string") into.add(id);
        continue;
      }
      collectReferencedIds(child, into);
    }
  }
}

async function stalenessInputs(
  companyContext: CompanyContext,
  tenantId: ObjectId,
  tenderId: ObjectId,
): Promise<{ corpusHash: string; companyDataHash: string }> {
  const [corpusHash, embeddedDocs] = await Promise.all([
    computeCorpusHash(tenderId),
    listEmbeddedCompanyDocs(tenantId),
  ]);
  return {
    corpusHash,
    companyDataHash: hashCompanyData(
      companyProfileInput(companyContext.company),
      embeddedDocs,
    ),
  };
}

export async function getReportState(
  companyContext: CompanyContext,
  tenderId: ObjectId,
): Promise<ReportState | null> {
  const tenantId = forCompanyContext(companyContext).value;
  const { tenderReports } = await getAiCollections();
  const doc = await tenderReports.findOne({ tenantId, tenderId });
  if (!doc) return null;

  const current = await stalenessInputs(companyContext, tenantId, tenderId);
  const stale =
    doc.inputs.corpusHash !== current.corpusHash ||
    doc.inputs.companyDataHash !== current.companyDataHash ||
    doc.model.promptVersion !== REPORT_PROMPT_VERSION;

  return { report: doc, stale };
}

/**
 * Generates the full tender report: assemble every artifact → one structured
 * call on the dedicated `report` model role → resolve the evidence IDs the
 * model cited → replace the stored report wholesale.
 *
 * This is the most expensive call in the product by design. It runs inline
 * (tens of seconds), so callers should stream or show progress.
 */
export async function generateTenderReport(input: {
  companyContext: CompanyContext;
  tenderId: ObjectId;
  tender: SerializedTenderDetail;
  locale: ReportLocale;
  onProgress?: (stage: ReportStage) => void;
}): Promise<TenderReportDocument> {
  const tenantId = forCompanyContext(input.companyContext).value;
  const started = Date.now();

  input.onProgress?.("gathering");
  const context = await buildReportContext({
    companyContext: input.companyContext,
    tenantId,
    tenderId: input.tenderId,
    tender: input.tender,
    locale: input.locale,
  });

  const model = await getChatModel({ role: "report" });
  const structured = model.withStructuredOutput<TenderReportContent>(
    REPORT_JSON_SCHEMA as never,
    { name: "tender_report" },
  );

  input.onProgress?.("analyzing");
  const report = reportSchema.parse(await structured.invoke(context.prompt));

  // Every other UI language is a TRANSLATION of this one analysis, never a
  // second analysis — two runs could reach two different verdicts.
  input.onProgress?.("translating");
  const byLocale: Partial<Record<ReportLocale, Record<string, unknown>>> = {
    [input.locale]: report as unknown as Record<string, unknown>,
  };
  await Promise.all(
    REPORT_LOCALES.filter((target) => target !== input.locale).map(
      async (target) => {
        try {
          const translated = reportSchema.parse(
            await structured.invoke(
              buildTranslationPrompt({ report, from: input.locale, to: target }),
            ),
          );
          byLocale[target] = translated as unknown as Record<string, unknown>;
        } catch (error) {
          // A failed translation must not lose the analysis we already have:
          // the language is simply absent and the reader falls back with a
          // visible notice.
          log.warn("report translation failed", {
            tenderId: String(input.tenderId),
            target,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    ),
  );

  input.onProgress?.("saving");
  // Only the IDs the model actually cited are persisted — the full evidence
  // table is large and the report renders citations, not the corpus.
  const referenced = new Set<string>();
  collectReferencedIds(report, referenced);
  const citations: Record<string, Record<string, unknown>> = {};
  for (const id of referenced) {
    const citation = context.evidence.byId.get(id);
    if (citation) {
      citations[id] = citation as unknown as Record<string, unknown>;
    }
  }

  const current = await stalenessInputs(
    input.companyContext,
    tenantId,
    input.tenderId,
  );
  const modelRef = resolveRole("report");
  const now = new Date();

  const doc: Omit<TenderReportDocument, "_id" | "createdAt"> = {
    tenantId,
    tenderId: input.tenderId,
    tender: {
      title: input.tender.title,
      buyerName: input.tender.buyer?.name ?? null,
      submissionDeadline: input.tender.submissionDeadline
        ? new Date(input.tender.submissionDeadline)
        : null,
      estimatedValue: input.tender.estimatedValue,
      procedureType: input.tender.procedureType,
    },
    companyName: input.companyContext.company.name ?? null,
    report: byLocale,
    citations,
    inputs: {
      corpusHash: current.corpusHash,
      companyDataHash: current.companyDataHash,
      extractionStatuses: context.inputs.extractionStatuses,
      tenderChunkCount: context.inputs.tenderChunkCount,
      companyChunkCount: context.inputs.companyChunkCount,
      hasOverview: context.inputs.hasOverview,
      hasVerdict: context.inputs.hasVerdict,
      hasFit: context.inputs.hasFit,
    },
    model: {
      provider: modelRef.provider,
      providerModel: modelRef.model,
      promptVersion: REPORT_PROMPT_VERSION,
    },
    primaryLocale: input.locale,
    generatedByUserId: input.companyContext.userId,
    generatedAt: now,
    updatedAt: now,
  };

  const { tenderReports } = await getAiCollections();
  await tenderReports.updateOne(
    { tenantId, tenderId: input.tenderId },
    { $set: doc, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );
  const stored = await tenderReports.findOne({
    tenantId,
    tenderId: input.tenderId,
  });

  log.info("tender report generated", {
    tenderId: String(input.tenderId),
    decision: report.recommendation.decision,
    requirements: report.requirements.length,
    risks: report.risks.length,
    citedEvidence: Object.keys(citations).length,
    languages: Object.keys(byLocale),
    durationMs: Date.now() - started,
  });

  return stored as TenderReportDocument;
}

/**
 * Compact card shape for listings (the chat workspace). Deliberately NOT the
 * full report: a report is tens of kilobytes and a listing would be unusable.
 */
export interface TenderReportSummary {
  tenderId: string;
  tenderTitle: string | null;
  buyerName: string | null;
  submissionDeadline: string | null;
  decision: TenderReportContent["recommendation"]["decision"];
  confidence: number;
  /** Opening paragraph of the executive summary. */
  headline: string;
  highRiskCount: number;
  gapCount: number;
  locale: ReportLocale;
  generatedAt: string;
  /**
   * Company data or the prompt changed since generation. The tender's DOCUMENT
   * corpus is deliberately NOT checked here — that costs one aggregation per
   * tender; the report page does the authoritative check.
   */
  maybeStale: boolean;
}

/** Every report this company has, newest first. */
export async function listReportSummaries(
  companyContext: CompanyContext,
  locale: ReportLocale,
  limit = 24,
): Promise<TenderReportSummary[]> {
  const tenantId = forCompanyContext(companyContext).value;
  const { tenderReports } = await getAiCollections();

  // Project only the few fields a card needs, in both languages so the
  // per-document fallback can be resolved without a second read.
  const projection: Record<string, 1> = {
    tenderId: 1,
    tender: 1,
    generatedAt: 1,
    primaryLocale: 1,
    "inputs.companyDataHash": 1,
    "model.promptVersion": 1,
  };
  for (const entry of REPORT_LOCALES) {
    projection[`report.${entry}.executiveSummary`] = 1;
    projection[`report.${entry}.recommendation`] = 1;
    projection[`report.${entry}.risks.severity`] = 1;
    projection[`report.${entry}.requirements.companyStatus`] = 1;
  }

  const docs = await tenderReports
    .find({ tenantId }, { projection })
    .sort({ generatedAt: -1 })
    .limit(limit)
    .toArray();
  if (docs.length === 0) return [];

  const companyDataHash = hashCompanyData(
    companyProfileInput(companyContext.company),
    await listEmbeddedCompanyDocs(tenantId),
  );

  return docs.flatMap((doc) => {
    const resolved = doc.report[locale] ? locale : doc.primaryLocale;
    const content = doc.report[resolved] as
      | Partial<TenderReportContent>
      | undefined;
    // A row with no readable language is a broken generation, not a card.
    if (!content?.recommendation) return [];

    return [
      {
        tenderId: String(doc.tenderId),
        tenderTitle: doc.tender.title,
        buyerName: doc.tender.buyerName,
        submissionDeadline: doc.tender.submissionDeadline
          ? doc.tender.submissionDeadline.toISOString()
          : null,
        decision: content.recommendation.decision,
        confidence: content.recommendation.confidence,
        headline: (content.executiveSummary ?? "").split(/\n{2,}/)[0] ?? "",
        highRiskCount: (content.risks ?? []).filter(
          (risk) => risk.severity === "high",
        ).length,
        gapCount: (content.requirements ?? []).filter(
          (requirement) => requirement.companyStatus === "gap",
        ).length,
        locale: resolved,
        generatedAt: doc.generatedAt.toISOString(),
        maybeStale:
          doc.inputs.companyDataHash !== companyDataHash ||
          doc.model.promptVersion !== REPORT_PROMPT_VERSION,
      },
    ];
  });
}

/** Wire shape for the report page and the exporters — one language resolved. */
export interface SerializedTenderReport {
  tenderId: string;
  report: TenderReportContent;
  citations: Record<string, ChatCitation>;
  tender: {
    title: string | null;
    buyerName: string | null;
    submissionDeadline: string | null;
    estimatedValue: { amount: string | null; currency: string | null } | null;
    procedureType: string | null;
  };
  companyName: string | null;
  coverage: TenderReportDocument["inputs"];
  model: TenderReportDocument["model"];
  /** The language actually returned. */
  locale: ReportLocale;
  /** Set when the requested language was unavailable and this is a fallback. */
  requestedLocale: ReportLocale | null;
  /** Languages this report exists in. */
  availableLocales: ReportLocale[];
  generatedAt: string;
  stale: boolean;
}

/**
 * Resolves one language out of the stored report. Falls back to the language
 * the analysis was written in, and reports that it did so — a reader must know
 * they are looking at a translation that never arrived.
 */
export function serializeReport(
  doc: TenderReportDocument,
  stale: boolean,
  locale: ReportLocale,
): SerializedTenderReport | null {
  const available = REPORT_LOCALES.filter((entry) => doc.report[entry] != null);
  const resolved = doc.report[locale]
    ? locale
    : doc.report[doc.primaryLocale]
      ? doc.primaryLocale
      : available[0];
  // No language stored at all — treat as if no report exists rather than
  // shipping an empty shell to the renderers.
  if (!resolved) return null;

  return {
    tenderId: String(doc.tenderId),
    report: doc.report[resolved] as unknown as TenderReportContent,
    citations: doc.citations as unknown as Record<string, ChatCitation>,
    tender: {
      title: doc.tender.title,
      buyerName: doc.tender.buyerName,
      submissionDeadline: doc.tender.submissionDeadline
        ? doc.tender.submissionDeadline.toISOString()
        : null,
      estimatedValue: doc.tender.estimatedValue,
      procedureType: doc.tender.procedureType,
    },
    companyName: doc.companyName,
    coverage: doc.inputs,
    model: doc.model,
    locale: resolved,
    requestedLocale: resolved === locale ? null : locale,
    availableLocales: available,
    generatedAt: doc.generatedAt.toISOString(),
    stale,
  };
}
