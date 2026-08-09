import { ObjectId } from "mongodb";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CompanyContext } from "../../company/context.ts";
import { REPORT_PROMPT_VERSION } from "./schema.ts";

/**
 * The chat listing. Each row resolves its OWN language (a company can have
 * German and English reports side by side), and a row whose stored language is
 * unreadable must be skipped rather than rendered as an empty card.
 */

const toArray = vi.fn();
const find = vi.fn(() => ({
  sort: () => ({ limit: () => ({ toArray }) }),
}));

vi.mock("../db/collections.ts", () => ({
  getAiCollections: async () => ({ tenderReports: { find } }),
}));
vi.mock("../fit/company-hash.ts", () => ({
  hashCompanyData: () => "CURRENT_HASH",
  listEmbeddedCompanyDocs: async () => [],
}));

const { listReportSummaries } = await import("./service.ts");

const companyContext = {
  userId: "user-1",
  email: "a@b.c",
  role: "admin",
  company: { _id: new ObjectId(), name: "Muster Bau GmbH" },
} as unknown as CompanyContext;

function content(overrides: Record<string, unknown> = {}) {
  return {
    executiveSummary: "Opening paragraph.\n\nSecond paragraph.",
    recommendation: { decision: "bid", confidence: 0.8 },
    risks: [{ severity: "high" }, { severity: "low" }, { severity: "high" }],
    requirements: [
      { companyStatus: "gap" },
      { companyStatus: "met" },
      { companyStatus: "gap" },
    ],
    ...overrides,
  };
}

function doc(
  report: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    tenderId: new ObjectId(),
    tender: {
      title: "Sanierung Grundschule",
      buyerName: "Stadt Musterstadt",
      submissionDeadline: new Date("2026-09-30T15:00:00.000Z"),
    },
    report,
    primaryLocale: "en",
    inputs: { companyDataHash: "CURRENT_HASH" },
    model: { promptVersion: REPORT_PROMPT_VERSION },
    generatedAt: new Date("2026-08-09T10:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  toArray.mockReset();
  find.mockClear();
});

describe("listReportSummaries", () => {
  it("summarises a report in the requested language", async () => {
    toArray.mockResolvedValue([
      doc({ en: content(), de: content({ executiveSummary: "Deutscher Anfang." }) }),
    ]);

    const [summary] = await listReportSummaries(companyContext, "de");
    expect(summary.locale).toBe("de");
    expect(summary.headline).toBe("Deutscher Anfang.");
    expect(summary.decision).toBe("bid");
    expect(summary.highRiskCount).toBe(2);
    expect(summary.gapCount).toBe(2);
    expect(summary.maybeStale).toBe(false);
  });

  it("uses only the first paragraph as the headline", async () => {
    toArray.mockResolvedValue([doc({ en: content() })]);
    const [summary] = await listReportSummaries(companyContext, "en");
    expect(summary.headline).toBe("Opening paragraph.");
  });

  it("falls back per document to the language it was written in", async () => {
    toArray.mockResolvedValue([doc({ en: content() }, { primaryLocale: "en" })]);
    const [summary] = await listReportSummaries(companyContext, "de");
    expect(summary.locale).toBe("en");
  });

  it("skips a row with no readable language instead of showing a blank card", async () => {
    toArray.mockResolvedValue([
      doc({}, { primaryLocale: "de" }),
      doc({ en: content() }),
    ]);
    expect(await listReportSummaries(companyContext, "en")).toHaveLength(1);
  });

  it("flags rows whose company data or prompt moved on", async () => {
    toArray.mockResolvedValue([
      doc({ en: content() }, { inputs: { companyDataHash: "OLD" } }),
      doc({ en: content() }, { model: { promptVersion: "rep-p0" } }),
    ]);
    const summaries = await listReportSummaries(companyContext, "en");
    expect(summaries.map((entry) => entry.maybeStale)).toEqual([true, true]);
  });

  it("only requests the handful of fields a card needs", async () => {
    toArray.mockResolvedValue([]);
    await listReportSummaries(companyContext, "en");
    const [filter, options] = find.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { projection: Record<string, 1> },
    ];
    expect(filter).toHaveProperty("tenantId");
    // Never the whole report — those are tens of kilobytes each.
    expect(options.projection).not.toHaveProperty("report");
    expect(options.projection).toHaveProperty("report.en.executiveSummary");
    expect(options.projection).toHaveProperty("report.de.recommendation");
  });
});
