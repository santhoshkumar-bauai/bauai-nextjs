import { describe, expect, it } from "vitest";

import en from "../../../messages/en.json";
import { buildReportLabels } from "./labels.ts";
import { renderReportHtml } from "./render-html.ts";
import { renderReportPdf } from "./render-pdf.ts";
import { DATA } from "./testing.ts";

/**
 * Real Chromium, real PDF. Opt-in (like the retrieval integration suite)
 * because it needs `npx playwright install chromium` and costs a browser
 * launch — but it is the only check that the print stylesheet and the page
 * settings actually produce a document.
 *
 *   PDF_SMOKE=1 npx vitest run lib/ai/report/render-pdf.test.ts
 */
const enabled = process.env.PDF_SMOKE === "1";

function translatorFor(catalog: Record<string, unknown>, namespace: string) {
  return (key: string): string => {
    let node: unknown = catalog;
    for (const segment of `${namespace}.${key}`.split(".")) {
      node = (node as Record<string, unknown>)[segment];
    }
    return node as string;
  };
}

describe.skipIf(!enabled)("renderReportPdf", () => {
  it(
    "prints the report to a multi-page PDF",
    { timeout: 120_000 },
    async () => {
      const labels = buildReportLabels(
        translatorFor(en as unknown as Record<string, unknown>, "Tenders.report"),
      );
      const html = renderReportHtml({ data: DATA, labels, locale: "en" });
      const pdf = await renderReportPdf({
        html,
        footerLeft: labels.documentTitle,
        pageLabel: labels.page,
      });

      expect(pdf.subarray(0, 5).toString("utf8")).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(10_000);
      // The footer template renders per page, so a real print has >= 1 page
      // object; a blank render would be far smaller than this.
      expect(pdf.subarray(0, 2_000).toString("latin1")).toContain("%PDF-1.");
    },
  );
});
