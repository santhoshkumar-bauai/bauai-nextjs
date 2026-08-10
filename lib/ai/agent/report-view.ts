import type { TenderReportContent } from "../report/schema.ts";

/**
 * Progressive disclosure for the tender report.
 *
 * A generated report is tens of kilobytes — pasting it into a tool result
 * would blow most of the model's context on one call and drown the actual
 * question. So the report tool returns a compact HEADLINE by default (the
 * decision, the scores and what each section holds) and hands over one section
 * at a time on request. The section list doubles as a menu: the summary tells
 * the model which sections are non-empty, so a follow-up call is targeted
 * rather than speculative.
 */

export const REPORT_SECTIONS = [
  "summary",
  "executive_summary",
  "recommendation",
  "overview",
  "key_facts",
  "timeline",
  "requirements",
  "commercials",
  "company_fit",
  "risks",
  "competition",
  "bid_strategy",
  "action_plan",
  "open_questions",
  "document_checklist",
  "data_gaps",
] as const;

export type ReportSection = (typeof REPORT_SECTIONS)[number];

/** Per-section output budget. Generous — one section at a time is affordable. */
const PROSE_CAP = 4_000;
const LIST_CAP = 20;

function cap(text: string | null | undefined, max = PROSE_CAP): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Non-empty section names, so the model can pick its next call from evidence. */
export function availableSections(report: TenderReportContent): ReportSection[] {
  const filled: ReportSection[] = ["executive_summary", "recommendation", "overview"];
  if (report.keyFacts?.length) filled.push("key_facts");
  if (report.timeline?.length) filled.push("timeline");
  if (report.requirements?.length) filled.push("requirements");
  if (report.commercials) filled.push("commercials");
  if (report.companyFit) filled.push("company_fit");
  if (report.risks?.length) filled.push("risks");
  if (report.competition) filled.push("competition");
  if (report.bidStrategy) filled.push("bid_strategy");
  if (report.actionPlan?.length) filled.push("action_plan");
  if (report.openQuestions?.length) filled.push("open_questions");
  if (report.documentChecklist?.length) filled.push("document_checklist");
  if (report.dataGaps?.length) filled.push("data_gaps");
  return filled;
}

function summaryOf(report: TenderReportContent): Record<string, unknown> {
  const requirements = report.requirements ?? [];
  const risks = report.risks ?? [];
  return {
    decision: report.recommendation.decision,
    confidence: report.recommendation.confidence,
    rationale: cap(report.recommendation.rationale, 1_500),
    conditions: (report.recommendation.conditions ?? []).slice(0, LIST_CAP),
    scores: report.scores,
    // The opening paragraph only — the rest is one call away.
    executiveSummaryOpening: cap(
      (report.executiveSummary ?? "").split(/\n{2,}/)[0],
      1_500,
    ),
    counts: {
      requirements: requirements.length,
      requirementGaps: requirements.filter((item) => item.companyStatus === "gap")
        .length,
      requirementsUnknown: requirements.filter(
        (item) => item.companyStatus === "unknown",
      ).length,
      risks: risks.length,
      highRisks: risks.filter((item) => item.severity === "high").length,
      actions: (report.actionPlan ?? []).length,
      openQuestions: (report.openQuestions ?? []).length,
    },
    dataGaps: (report.dataGaps ?? []).slice(0, 8),
    availableSections: availableSections(report),
  };
}

/**
 * Projects one section of a stored report into a bounded, model-readable
 * object. Report prose is MODEL-AUTHORED from verified artifacts, not raw
 * document text, so it is not wrapped in `<document>` markers — the verbatim
 * source quotes it rests on stay behind `get_extractions`.
 */
export function projectReportSection(
  report: TenderReportContent,
  section: ReportSection,
): Record<string, unknown> {
  switch (section) {
    case "summary":
      return summaryOf(report);

    case "executive_summary":
      return { executiveSummary: cap(report.executiveSummary, 6_000) };

    case "recommendation":
      return {
        decision: report.recommendation.decision,
        confidence: report.recommendation.confidence,
        rationale: cap(report.recommendation.rationale),
        conditions: report.recommendation.conditions ?? [],
        scores: report.scores,
      };

    case "overview":
      return {
        purpose: cap(report.tenderOverview.purpose, 2_000),
        scope: cap(report.tenderOverview.scope),
        buyer: cap(report.tenderOverview.buyer, 2_000),
        procedure: cap(report.tenderOverview.procedure, 2_000),
        lots: (report.tenderOverview.lots ?? []).slice(0, 12),
      };

    case "key_facts":
      return { keyFacts: (report.keyFacts ?? []).slice(0, 25) };

    case "timeline":
      return { timeline: (report.timeline ?? []).slice(0, 25) };

    case "requirements":
      return {
        requirements: (report.requirements ?? []).slice(0, 40).map((item) => ({
          requirement: item.requirement,
          category: item.category,
          mandatory: item.mandatory,
          companyStatus: item.companyStatus,
          evidence: cap(item.evidence, 600),
          action: item.action,
          evidenceIds: item.evidenceIds,
        })),
      };

    case "commercials":
      return {
        valueAssessment: cap(report.commercials.valueAssessment, 2_000),
        paymentTerms: cap(report.commercials.paymentTerms, 2_000),
        retentionsAndSecurities: cap(
          report.commercials.retentionsAndSecurities,
          2_000,
        ),
        penalties: cap(report.commercials.penalties, 2_000),
        priceRisks: (report.commercials.priceRisks ?? []).slice(0, LIST_CAP),
      };

    case "company_fit":
      return {
        summary: cap(report.companyFit.summary, 2_000),
        strengths: (report.companyFit.strengths ?? []).slice(0, LIST_CAP),
        gaps: (report.companyFit.gaps ?? []).slice(0, LIST_CAP),
        differentiators: (report.companyFit.differentiators ?? []).slice(0, LIST_CAP),
        capacityAssessment: cap(report.companyFit.capacityAssessment, 2_000),
      };

    case "risks":
      return { risks: (report.risks ?? []).slice(0, 15) };

    case "competition":
      return { competition: cap(report.competition) };

    case "bid_strategy":
      return {
        winThemes: (report.bidStrategy.winThemes ?? []).slice(0, LIST_CAP),
        pricingApproach: cap(report.bidStrategy.pricingApproach, 2_000),
        partnering: cap(report.bidStrategy.partnering, 2_000),
        effortEstimate: cap(report.bidStrategy.effortEstimate, 2_000),
      };

    case "action_plan":
      return { actionPlan: (report.actionPlan ?? []).slice(0, 25) };

    case "open_questions":
      return { openQuestions: (report.openQuestions ?? []).slice(0, 20) };

    case "document_checklist":
      return { documentChecklist: (report.documentChecklist ?? []).slice(0, 40) };

    case "data_gaps":
      return { dataGaps: report.dataGaps ?? [] };
  }
}
