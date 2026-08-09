import { reportSchema, type TenderReportContent } from "./schema.ts";
import type { SerializedTenderReport } from "./service.ts";

/**
 * A complete, schema-valid sample report. Shared by the renderer unit tests
 * and the opt-in PDF smoke test so both exercise the same shape a real
 * generation produces — including an evidence id that resolves to no
 * citation, which the renderers must drop.
 */
export const REPORT: TenderReportContent = reportSchema.parse({
  executiveSummary: "First paragraph.\n\nSecond paragraph.",
  recommendation: {
    decision: "conditional",
    confidence: 0.62,
    rationale: "The scope fits but the bonding requirement is unproven.",
    conditions: ["Obtain a surety confirmation before the deadline."],
  },
  scores: {
    eligibilityFit: 0.7,
    technicalFit: 0.85,
    capacityFit: 0.5,
    commercialAttractiveness: 0.6,
    contractRisk: 0.72,
    deadlineFeasibility: 0.4,
  },
  tenderOverview: {
    purpose: "The city is procuring a school refurbishment.",
    scope: "Demolition works.\n\nNew screed and flooring across 2,400 m².",
    lots: [{ name: "Lot 1 — Flooring", summary: "2,400 m² screed", relevantToCompany: true }],
    buyer: "A municipal building authority.",
    procedure: "Open procedure under VOB/A.",
  },
  keyFacts: [
    { label: "Submission deadline", value: "2026-09-30", note: "17:00 local time" },
    { label: "Estimated value", value: "1,200,000 EUR", note: null },
  ],
  timeline: [
    {
      date: "2026-09-30",
      label: "Submission deadline",
      detail: "Bids must be uploaded to the portal.",
      critical: true,
    },
    { date: null, label: "Award", detail: "Not stated in the notice.", critical: false },
  ],
  requirements: [
    {
      requirement: "Three comparable references from the last five years.",
      category: "reference",
      mandatory: true,
      companyStatus: "partial",
      evidence: "Two comparable projects are on file.",
      action: "Add a third reference.",
      evidenceIds: ["E1", "ZZ9"],
    },
  ],
  commercials: {
    valueAssessment: "Within the company's usual project band.",
    paymentTerms: "30 days net.",
    retentionsAndSecurities: "5% performance bond.",
    penalties: "0.2% per working day, capped at 5%.",
    priceRisks: ["Material escalation is not indexed."],
  },
  companyFit: {
    summary: "A good technical match with a capacity question.",
    strengths: [{ text: "Direct screed experience.", evidenceIds: ["C1"] }],
    gaps: [{ text: "No bonding evidence on file.", evidenceIds: [] }],
    differentiators: ["In-house flooring crew."],
    capacityAssessment: "Revenue supports the contract; crew availability is tight.",
  },
  risks: [
    {
      title: "Bonding capacity",
      severity: "high",
      likelihood: "medium",
      impact: "Bid rejected as incomplete.",
      mitigation: "Request a surety letter this week.",
      evidenceIds: ["R1"],
    },
  ],
  competition: "An open procedure in a dense regional market.",
  bidStrategy: {
    winThemes: ["Local crew, no travel premium."],
    pricingApproach: "Price the screed aggressively.",
    partnering: "No partners needed.",
    effortEstimate: "About three days of bid work.",
  },
  actionPlan: [
    {
      action: "Request the surety confirmation.",
      priority: "immediate",
      dueBy: "2026-09-10",
      rationale: "It gates eligibility.",
    },
  ],
  openQuestions: [
    {
      question: "Is the screed thickness fixed?",
      whoToAsk: "The buyer's technical contact.",
      why: "It changes the material price.",
    },
  ],
  documentChecklist: [
    { document: "Form 124 self-declaration", source: "must_produce", note: null },
  ],
  dataGaps: ["No award criteria were published with the notice."],
});

export const DATA: SerializedTenderReport = {
  tenderId: "0123456789abcdef01234567",
  report: REPORT,
  citations: {
    E1: {
      key: "E1",
      quote: "Drei vergleichbare Referenzen",
      fileName: "Eignungskriterien.pdf",
      documentRecordId: "doc-1",
      chunkId: "chunk-1",
    },
    R1: {
      key: "R1",
      quote: "Vertragserfüllungsbürgschaft in Höhe von 5 %",
      fileName: "Vertragsbedingungen.pdf",
      documentRecordId: "doc-2",
      chunkId: "chunk-2",
    },
    C1: {
      key: "C1",
      quote: "Estricharbeiten Grundschule Musterstadt",
      fileName: "Referenzen.docx",
      documentRecordId: "company:1",
      chunkId: "chunk-3",
    },
  },
  tender: {
    title: "Sanierung Grundschule — Estrich & Bodenbelag",
    buyerName: "Stadt Musterstadt",
    submissionDeadline: "2026-09-30T15:00:00.000Z",
    estimatedValue: { amount: "1200000", currency: "EUR" },
    procedureType: "Offenes Verfahren",
  },
  companyName: "Muster Bau GmbH",
  coverage: {
    corpusHash: "abc",
    companyDataHash: "def",
    extractionStatuses: { deadlines: "VERIFIED", payment_terms: "PARTIAL" },
    tenderChunkCount: 32,
    companyChunkCount: 9,
    hasOverview: true,
    hasVerdict: true,
    hasFit: false,
  },
  model: { provider: "gemini", providerModel: "test-model", promptVersion: "rep-p1" },
  locale: "en",
  requestedLocale: null,
  availableLocales: ["en", "de"],
  generatedAt: "2026-08-09T10:00:00.000Z",
  stale: true,
};
