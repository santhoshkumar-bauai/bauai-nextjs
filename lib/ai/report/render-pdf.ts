import { logger } from "../../ingestion/observability/logger.ts";

const log = logger.child("ai.report.pdf");

/**
 * Renders the report's print HTML to a real PDF with headless Chromium.
 *
 * Deliberately NOT the ingestion browser singleton: that one is a long-lived,
 * rate-limited, German-locale scraping context. Exports are rare, manual and
 * must not keep a browser resident in the web process, so this launches and
 * closes per call (~1s) and never reaches the network — `setContent` on
 * self-contained HTML, so nothing external can be pulled in.
 */

/** Chromium must be installed on the host: `npx playwright install chromium`. */
export class PdfUnavailableError extends Error {
  constructor(cause: string) {
    super(
      "PDF export needs headless Chromium. Install it with `npx playwright install chromium` " +
        `on the web host. Underlying error: ${cause}`,
    );
    this.name = "PdfUnavailableError";
  }
}

export async function renderReportPdf(input: {
  html: string;
  footerLeft: string;
  pageLabel: string;
}): Promise<Buffer> {
  const started = Date.now();
  const { chromium } = await import("playwright");

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      // Container-safe: no SUID sandbox helper is shipped, and the default
      // 64 MB /dev/shm is too small under Docker.
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (error) {
    throw new PdfUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }

  try {
    const page = await browser.newPage();
    // The HTML embeds all of its own styling, so "load" is genuinely settled.
    await page.setContent(input.html, { waitUntil: "load", timeout: 30_000 });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<div></div>",
      footerTemplate: `<div style="width:100%;font-size:7pt;color:#8a8d95;padding:0 16mm;display:flex;justify-content:space-between;">
        <span>${escapeForTemplate(input.footerLeft)}</span>
        <span>${escapeForTemplate(input.pageLabel)} <span class="pageNumber"></span> / <span class="totalPages"></span></span>
      </div>`,
      margin: { top: "18mm", bottom: "20mm", left: "16mm", right: "16mm" },
    });
    log.info("report pdf rendered", {
      bytes: pdf.length,
      durationMs: Date.now() - started,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/** The footer template is raw HTML injected by Chromium — escape it. */
function escapeForTemplate(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
