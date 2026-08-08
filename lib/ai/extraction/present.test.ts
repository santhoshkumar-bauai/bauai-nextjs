import { describe, expect, it } from "vitest";

import { presentFieldValue } from "./present.ts";

describe("presentFieldValue", () => {
  it("classifies ISO datetimes and dates", () => {
    expect(presentFieldValue("submissionDeadline", "2026-09-02T12:00:00+02:00")).toEqual({
      kind: "datetime",
      iso: "2026-09-02T12:00:00+02:00",
    });
    expect(presentFieldValue("bindingPeriodEnd", "2026-11-02")).toEqual({
      kind: "date",
      iso: "2026-11-02",
    });
  });

  it("classifies numbers by field-name convention", () => {
    expect(presentFieldValue("minAnnualRevenueEur", 3_000_000)).toEqual({
      kind: "currency",
      amount: 3_000_000,
    });
    expect(presentFieldValue("priceWeightPercent", 70)).toEqual({
      kind: "percent",
      value: 70,
    });
    expect(presentFieldValue("delayPenaltyPercentPerDay", 0.2)).toEqual({
      kind: "percent",
      value: 0.2,
    });
    expect(presentFieldValue("paymentDeadlineDays", 30)).toEqual({
      kind: "days",
      value: 30,
    });
    expect(presentFieldValue("minReferenceCount", 3)).toEqual({
      kind: "number",
      value: 3,
    });
  });

  it("classifies booleans and plain text", () => {
    expect(presentFieldValue("priceOnly", false)).toEqual({ kind: "boolean", value: false });
    expect(presentFieldValue("invoicingRules", "XRechnung erforderlich")).toEqual({
      kind: "text",
      value: "XRechnung erforderlich",
    });
  });

  it("classifies structured arrays by shape", () => {
    expect(
      presentFieldValue("requiredCertifications", ["ISO 9001", "ISO 14001"]),
    ).toEqual({ kind: "stringList", items: ["ISO 9001", "ISO 14001"] });

    expect(
      presentFieldValue("criteria", [{ name: "Preis", weightPercent: 70 }]),
    ).toMatchObject({ kind: "criteria" });

    expect(
      presentFieldValue("proofs", [
        { name: "Eigenerklärung", kind: "self_declaration", mandatory: true, due: "with_bid" },
      ]),
    ).toMatchObject({
      kind: "proofs",
      items: [{ proofKind: "self_declaration", mandatory: true, due: "with_bid" }],
    });

    expect(
      presentFieldValue("penaltyClauses", [{ text: "0,2 % je Werktag", legalRef: null }]),
    ).toMatchObject({ kind: "clauses" });
  });

  it("falls back to unknown for odd shapes", () => {
    expect(presentFieldValue("x", { odd: true })).toMatchObject({ kind: "unknown" });
    expect(presentFieldValue("x", [{ odd: true }])).toMatchObject({ kind: "unknown" });
  });
});
