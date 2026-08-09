import { describe, expect, it } from "vitest";

import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { buildReportLabels } from "./labels.ts";
import { renderReportDocx } from "./render-docx.ts";
import { renderReportHtml } from "./render-html.ts";
import { DATA } from "./testing.ts";

/**
 * The two exporters and the label bundle, exercised against the REAL message
 * catalogs. A missing translation key surfaces here as a thrown error rather
 * than as a broken download in production.
 */

/** A translator over one namespace of a real catalog — mirrors next-intl. */
function translatorFor(catalog: Record<string, unknown>, namespace: string) {
  return (key: string): string => {
    const path = `${namespace}.${key}`.split(".");
    let node: unknown = catalog;
    for (const segment of path) {
      if (typeof node !== "object" || node === null) {
        throw new Error(`missing message: ${path.join(".")}`);
      }
      node = (node as Record<string, unknown>)[segment];
    }
    if (typeof node !== "string") {
      throw new Error(`missing message: ${path.join(".")}`);
    }
    return node;
  };
}

describe("report label bundle", () => {
  it.each([
    ["en", en],
    ["de", de],
  ])("resolves every label from the %s catalog", (_locale, catalog) => {
    expect(() =>
      buildReportLabels(
        translatorFor(catalog as unknown as Record<string, unknown>, "Tenders.report"),
      ),
    ).not.toThrow();
  });
});

describe("renderReportHtml", () => {
  const labels = buildReportLabels(
    translatorFor(en as unknown as Record<string, unknown>, "Tenders.report"),
  );
  const html = renderReportHtml({ data: DATA, labels, locale: "en" });

  it("emits a self-contained document with every section", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    // No external resource may be referenced — Chromium prints this offline.
    expect(html).not.toMatch(/<(script|link)\b/);
    for (const heading of [
      labels.sections.executiveSummary,
      labels.sections.requirements,
      labels.sections.risks,
      labels.sections.actionPlan,
      labels.sections.dataGaps,
      labels.sections.sources,
    ]) {
      expect(html).toContain(heading);
    }
  });

  it("renders the stale banner and the decision", () => {
    expect(html).toContain(labels.staleWarning);
    expect(html).toContain(labels.recommendation.decision.conditional);
  });

  it("drops evidence ids that resolve to no citation", () => {
    expect(html).toContain("[E1]");
    expect(html).not.toContain("ZZ9");
  });

  it("escapes untrusted text rather than emitting it as markup", () => {
    const injected = renderReportHtml({
      data: {
        ...DATA,
        tender: { ...DATA.tender, title: '<img src=x onerror="alert(1)">' },
      },
      labels,
      locale: "en",
    });
    expect(injected).not.toContain("<img");
    expect(injected).toContain("&lt;img");
  });
});

describe("renderReportDocx", () => {
  it("produces a non-trivial .docx package", async () => {
    const labels = buildReportLabels(
      translatorFor(de as unknown as Record<string, unknown>, "Tenders.report"),
    );
    const buffer = await renderReportDocx({ data: DATA, labels, locale: "de" });
    // A .docx is a zip: "PK\x03\x04".
    expect(Array.from(buffer.subarray(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(buffer.length).toBeGreaterThan(5_000);
  });
});
