import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";

import type { TenderReportDocument } from "../types.ts";
import { serializeReport } from "./service.ts";
import { REPORT } from "./testing.ts";

/**
 * Language resolution. The report is written once and translated, so which
 * language a reader gets — and whether they are told it is a fallback — is the
 * whole contract of the multi-language feature.
 */

function documentWith(
  report: TenderReportDocument["report"],
  primaryLocale: "en" | "de" = "en",
): TenderReportDocument {
  const now = new Date("2026-08-09T10:00:00.000Z");
  return {
    _id: new ObjectId(),
    tenantId: new ObjectId(),
    tenderId: new ObjectId(),
    tender: {
      title: "Test",
      buyerName: "Buyer",
      submissionDeadline: null,
      estimatedValue: null,
      procedureType: null,
    },
    companyName: "Muster Bau GmbH",
    report,
    citations: {},
    inputs: {
      corpusHash: "a",
      companyDataHash: "b",
      extractionStatuses: {},
      tenderChunkCount: 0,
      companyChunkCount: 0,
      hasOverview: false,
      hasVerdict: false,
      hasFit: false,
    },
    model: { provider: "gemini", providerModel: "m", promptVersion: "rep-p1" },
    primaryLocale,
    generatedByUserId: "user-1",
    generatedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

const EN = REPORT as unknown as Record<string, unknown>;
const DE = {
  ...(REPORT as unknown as Record<string, unknown>),
  executiveSummary: "Deutsche Zusammenfassung.",
};

describe("serializeReport", () => {
  it("returns the requested language when it exists", () => {
    const result = serializeReport(documentWith({ en: EN, de: DE }), false, "de");
    expect(result?.locale).toBe("de");
    expect(result?.requestedLocale).toBeNull();
    expect(result?.report.executiveSummary).toBe("Deutsche Zusammenfassung.");
    expect(result?.availableLocales).toEqual(["en", "de"]);
  });

  it("falls back to the language the analysis was written in, and says so", () => {
    // Translation into German failed, so only the English analysis is stored.
    const result = serializeReport(documentWith({ en: EN }, "en"), false, "de");
    expect(result?.locale).toBe("en");
    expect(result?.requestedLocale).toBe("de");
    expect(result?.availableLocales).toEqual(["en"]);
  });

  it("prefers the primary language over an arbitrary stored one", () => {
    const result = serializeReport(documentWith({ de: DE }, "de"), false, "en");
    expect(result?.locale).toBe("de");
    expect(result?.requestedLocale).toBe("en");
  });

  it("returns null when no language was stored at all", () => {
    expect(serializeReport(documentWith({}), false, "en")).toBeNull();
  });

  it("carries the staleness flag through", () => {
    expect(serializeReport(documentWith({ en: EN }), true, "en")?.stale).toBe(true);
  });
});
