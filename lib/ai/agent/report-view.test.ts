import { describe, expect, it } from "vitest";

import type { TenderReportContent } from "../report/schema.ts";
import {
  availableSections,
  projectReportSection,
  REPORT_SECTIONS,
} from "./report-view.ts";

function reportOf(overrides: Partial<TenderReportContent> = {}): TenderReportContent {
  return {
    executiveSummary: "Opening paragraph.\n\nSecond.\n\nThird.",
    recommendation: {
      decision: "bid",
      confidence: 0.8,
      rationale: "Because the company matches.",
      conditions: [],
    },
    scores: {
      eligibilityFit: 0.9,
      technicalFit: 0.8,
      capacityFit: 0.7,
      commercialAttractiveness: 0.6,
      contractRisk: 0.3,
      deadlineFeasibility: 0.9,
    },
    tenderOverview: {
      purpose: "p",
      scope: "s",
      lots: [],
      buyer: "b",
      procedure: "proc",
    },
    keyFacts: [],
    timeline: [],
    requirements: [],
    commercials: {
      valueAssessment: "v",
      paymentTerms: "pt",
      retentionsAndSecurities: "r",
      penalties: "pen",
      priceRisks: [],
    },
    companyFit: {
      summary: "fit",
      strengths: [],
      gaps: [],
      differentiators: [],
      capacityAssessment: "cap",
    },
    risks: [],
    competition: "c",
    bidStrategy: {
      winThemes: [],
      pricingApproach: "pa",
      partnering: "pp",
      effortEstimate: "ee",
    },
    actionPlan: [],
    openQuestions: [],
    documentChecklist: [],
    dataGaps: [],
    ...overrides,
  } as TenderReportContent;
}

describe("projectReportSection", () => {
  it("every declared section projects without throwing", () => {
    const report = reportOf();
    for (const section of REPORT_SECTIONS) {
      expect(projectReportSection(report, section)).toBeTypeOf("object");
    }
  });

  it("the summary carries the decision and counts, not the whole report", () => {
    const summary = projectReportSection(
      reportOf({
        requirements: [
          { requirement: "a", companyStatus: "gap" },
          { requirement: "b", companyStatus: "unknown" },
          { requirement: "c", companyStatus: "met" },
        ] as never,
        risks: [{ severity: "high" }, { severity: "low" }] as never,
      }),
      "summary",
    );
    expect(summary.decision).toBe("bid");
    expect(summary.counts).toMatchObject({
      requirements: 3,
      requirementGaps: 1,
      requirementsUnknown: 1,
      highRisks: 1,
    });
    // Only the first paragraph — the full text is one targeted call away.
    expect(summary.executiveSummaryOpening).toBe("Opening paragraph.");
    expect(JSON.stringify(summary)).not.toContain("Third.");
  });

  it("truncates long prose instead of returning it whole", () => {
    const projected = projectReportSection(
      reportOf({ competition: "x".repeat(20_000) }),
      "competition",
    );
    expect(String(projected.competition).length).toBeLessThanOrEqual(4_001);
    expect(String(projected.competition).endsWith("…")).toBe(true);
  });

  it("keeps evidence ids on the sections that make claims about the company", () => {
    const projected = projectReportSection(
      reportOf({
        requirements: [
          {
            requirement: "Haftpflicht",
            category: "insurance",
            mandatory: true,
            companyStatus: "gap",
            evidence: "none on file",
            action: "obtain",
            evidenceIds: ["E3"],
          },
        ] as never,
      }),
      "requirements",
    );
    expect(
      (projected.requirements as Array<{ evidenceIds: string[] }>)[0].evidenceIds,
    ).toEqual(["E3"]);
  });
});

describe("availableSections", () => {
  it("lists only sections the report actually filled", () => {
    const empty = availableSections(reportOf());
    expect(empty).toContain("recommendation");
    expect(empty).not.toContain("risks");
    expect(empty).not.toContain("action_plan");

    const filled = availableSections(
      reportOf({
        risks: [{ severity: "high" }] as never,
        actionPlan: [{ action: "do it" }] as never,
      }),
    );
    expect(filled).toContain("risks");
    expect(filled).toContain("action_plan");
  });

  it("never names a section the projector cannot render", () => {
    for (const section of availableSections(reportOf())) {
      expect(REPORT_SECTIONS).toContain(section);
    }
  });
});
