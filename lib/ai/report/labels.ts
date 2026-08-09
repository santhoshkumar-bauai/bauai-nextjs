/**
 * Every string the export renderers put on the page. The PDF and the DOCX are
 * built outside React, so they cannot call `useTranslations` — the route
 * resolves this object from `messages/*.json` once and hands it to both, which
 * keeps one source of truth for the copy.
 */
export interface ReportLabels {
  documentTitle: string;
  preparedFor: string;
  generatedAt: string;
  poweredBy: string;
  disclaimer: string;
  staleWarning: string;
  buyer: string;
  deadline: string;
  estimatedValue: string;
  procedure: string;
  notProvided: string;
  none: string;
  page: string;

  sections: {
    executiveSummary: string;
    recommendation: string;
    scores: string;
    overview: string;
    keyFacts: string;
    timeline: string;
    requirements: string;
    commercials: string;
    companyFit: string;
    risks: string;
    competition: string;
    bidStrategy: string;
    actionPlan: string;
    openQuestions: string;
    documentChecklist: string;
    dataGaps: string;
    sources: string;
    coverage: string;
  };

  overview: {
    purpose: string;
    scope: string;
    lots: string;
    buyer: string;
    procedure: string;
    relevant: string;
    notRelevant: string;
  };

  recommendation: {
    confidence: string;
    rationale: string;
    conditions: string;
    decision: { bid: string; conditional: string; no_bid: string };
  };

  scores: {
    eligibilityFit: string;
    technicalFit: string;
    capacityFit: string;
    commercialAttractiveness: string;
    contractRisk: string;
    deadlineFeasibility: string;
    riskHint: string;
  };

  requirements: {
    requirement: string;
    category: string;
    mandatory: string;
    status: string;
    evidence: string;
    action: string;
    mandatoryYes: string;
    mandatoryNo: string;
    categories: Record<string, string>;
    statuses: Record<string, string>;
  };

  commercials: {
    valueAssessment: string;
    paymentTerms: string;
    retentionsAndSecurities: string;
    penalties: string;
    priceRisks: string;
  };

  companyFit: {
    strengths: string;
    gaps: string;
    differentiators: string;
    capacity: string;
  };

  risks: {
    risk: string;
    severity: string;
    likelihood: string;
    impact: string;
    mitigation: string;
    levels: Record<string, string>;
  };

  timeline: { date: string; event: string; detail: string; critical: string };

  bidStrategy: {
    winThemes: string;
    pricingApproach: string;
    partnering: string;
    effortEstimate: string;
  };

  actionPlan: {
    action: string;
    priority: string;
    dueBy: string;
    rationale: string;
    priorities: Record<string, string>;
  };

  openQuestions: { question: string; whoToAsk: string; why: string };

  checklist: {
    document: string;
    source: string;
    note: string;
    sources: Record<string, string>;
  };

  coverage: {
    tenderExcerpts: string;
    companyExcerpts: string;
    extractions: string;
    overviewUsed: string;
    fitUsed: string;
    verdictUsed: string;
    yes: string;
    no: string;
  };
}

/** Shape of the `next-intl` translator this module needs. */
type Translate = (key: string) => string;

/** Builds the label bundle from the `Tenders.report` message namespace. */
export function buildReportLabels(t: Translate): ReportLabels {
  const map = (prefix: string, keys: string[]): Record<string, string> =>
    Object.fromEntries(keys.map((key) => [key, t(`${prefix}.${key}`)]));

  return {
    documentTitle: t("documentTitle"),
    preparedFor: t("preparedFor"),
    generatedAt: t("generatedAt"),
    poweredBy: t("poweredBy"),
    disclaimer: t("disclaimer"),
    staleWarning: t("staleWarning"),
    buyer: t("buyer"),
    deadline: t("deadline"),
    estimatedValue: t("estimatedValue"),
    procedure: t("procedure"),
    notProvided: t("notProvided"),
    none: t("none"),
    page: t("page"),
    sections: {
      executiveSummary: t("sections.executiveSummary"),
      recommendation: t("sections.recommendation"),
      scores: t("sections.scores"),
      overview: t("sections.overview"),
      keyFacts: t("sections.keyFacts"),
      timeline: t("sections.timeline"),
      requirements: t("sections.requirements"),
      commercials: t("sections.commercials"),
      companyFit: t("sections.companyFit"),
      risks: t("sections.risks"),
      competition: t("sections.competition"),
      bidStrategy: t("sections.bidStrategy"),
      actionPlan: t("sections.actionPlan"),
      openQuestions: t("sections.openQuestions"),
      documentChecklist: t("sections.documentChecklist"),
      dataGaps: t("sections.dataGaps"),
      sources: t("sections.sources"),
      coverage: t("sections.coverage"),
    },
    overview: {
      purpose: t("overview.purpose"),
      scope: t("overview.scope"),
      lots: t("overview.lots"),
      buyer: t("overview.buyer"),
      procedure: t("overview.procedure"),
      relevant: t("overview.relevant"),
      notRelevant: t("overview.notRelevant"),
    },
    recommendation: {
      confidence: t("recommendation.confidence"),
      rationale: t("recommendation.rationale"),
      conditions: t("recommendation.conditions"),
      decision: {
        bid: t("recommendation.decision.bid"),
        conditional: t("recommendation.decision.conditional"),
        no_bid: t("recommendation.decision.no_bid"),
      },
    },
    scores: {
      eligibilityFit: t("scores.eligibilityFit"),
      technicalFit: t("scores.technicalFit"),
      capacityFit: t("scores.capacityFit"),
      commercialAttractiveness: t("scores.commercialAttractiveness"),
      contractRisk: t("scores.contractRisk"),
      deadlineFeasibility: t("scores.deadlineFeasibility"),
      riskHint: t("scores.riskHint"),
    },
    requirements: {
      requirement: t("requirements.requirement"),
      category: t("requirements.category"),
      mandatory: t("requirements.mandatory"),
      status: t("requirements.status"),
      evidence: t("requirements.evidence"),
      action: t("requirements.action"),
      mandatoryYes: t("requirements.mandatoryYes"),
      mandatoryNo: t("requirements.mandatoryNo"),
      categories: map("requirements.categories", [
        "eligibility",
        "technical",
        "financial",
        "insurance",
        "certification",
        "reference",
        "formal",
        "other",
      ]),
      statuses: map("requirements.statuses", ["met", "partial", "gap", "unknown"]),
    },
    commercials: {
      valueAssessment: t("commercials.valueAssessment"),
      paymentTerms: t("commercials.paymentTerms"),
      retentionsAndSecurities: t("commercials.retentionsAndSecurities"),
      penalties: t("commercials.penalties"),
      priceRisks: t("commercials.priceRisks"),
    },
    companyFit: {
      strengths: t("companyFit.strengths"),
      gaps: t("companyFit.gaps"),
      differentiators: t("companyFit.differentiators"),
      capacity: t("companyFit.capacity"),
    },
    risks: {
      risk: t("risks.risk"),
      severity: t("risks.severity"),
      likelihood: t("risks.likelihood"),
      impact: t("risks.impact"),
      mitigation: t("risks.mitigation"),
      levels: map("risks.levels", ["low", "medium", "high"]),
    },
    timeline: {
      date: t("timeline.date"),
      event: t("timeline.event"),
      detail: t("timeline.detail"),
      critical: t("timeline.critical"),
    },
    bidStrategy: {
      winThemes: t("bidStrategy.winThemes"),
      pricingApproach: t("bidStrategy.pricingApproach"),
      partnering: t("bidStrategy.partnering"),
      effortEstimate: t("bidStrategy.effortEstimate"),
    },
    actionPlan: {
      action: t("actionPlan.action"),
      priority: t("actionPlan.priority"),
      dueBy: t("actionPlan.dueBy"),
      rationale: t("actionPlan.rationale"),
      priorities: map("actionPlan.priorities", ["immediate", "high", "normal"]),
    },
    openQuestions: {
      question: t("openQuestions.question"),
      whoToAsk: t("openQuestions.whoToAsk"),
      why: t("openQuestions.why"),
    },
    checklist: {
      document: t("checklist.document"),
      source: t("checklist.source"),
      note: t("checklist.note"),
      sources: map("checklist.sources", [
        "company_has",
        "must_obtain",
        "must_produce",
        "unknown",
      ]),
    },
    coverage: {
      tenderExcerpts: t("coverage.tenderExcerpts"),
      companyExcerpts: t("coverage.companyExcerpts"),
      extractions: t("coverage.extractions"),
      overviewUsed: t("coverage.overviewUsed"),
      fitUsed: t("coverage.fitUsed"),
      verdictUsed: t("coverage.verdictUsed"),
      yes: t("coverage.yes"),
      no: t("coverage.no"),
    },
  };
}
