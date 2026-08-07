import type { Browser, BrowserContext } from "playwright";

import { logger } from "../observability/logger.ts";

const log = logger.child("documents.browser");

/**
 * Headless-Chromium rendering for portals that build their document list in the
 * browser (single-page apps) or hand it out through an XHR the page fires after load.
 * A static `http.html()` returns only the shell for those, so a resolver opts into
 * rendering here instead.
 *
 * The browser is a lazily-launched singleton reused across rows: launching Chromium
 * costs ~300 ms and a resolver run may touch hundreds of pages, so one instance with a
 * fresh page per request is the right trade. It is gated behind `DOCUMENTS_BROWSER_ENABLED`
 * so an environment without the Chromium binary (or that wants to stay static-only)
 * degrades to "unavailable" rather than throwing.
 */
const ENABLED = (process.env.DOCUMENTS_BROWSER_ENABLED ?? "true").toLowerCase() !== "false";

const USER_AGENT =
  process.env.DOCUMENTS_USER_AGENT ||
  "bau-ai-tender-documents/1.0 (+https://bau.ai; contact: santhosh@cunardai.com)";

const NAV_TIMEOUT_MS = Number.parseInt(
  process.env.DOCUMENTS_BROWSER_TIMEOUT_MS ?? "45000",
  10,
);

let browserPromise: Promise<Browser> | null = null;
let contextPromise: Promise<BrowserContext> | null = null;

export function browserAvailable(): boolean {
  return ENABLED;
}

async function getContext(): Promise<BrowserContext> {
  if (!browserPromise) {
    const { chromium } = await import("playwright");
    log.info("launching headless chromium");
    browserPromise = chromium.launch({ headless: true });
  }
  if (!contextPromise) {
    contextPromise = browserPromise.then((browser) =>
      browser.newContext({
        userAgent: USER_AGENT,
        locale: "de-DE",
        // Real portals gate on a plausible viewport; the default headless size is fine.
        acceptDownloads: false,
      }),
    );
  }
  return contextPromise;
}

export interface RenderOptions {
  /** Playwright load state to await. `networkidle` suits SPAs that fetch after load. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** Extra guarantee the content is present before the DOM is read. */
  waitForSelector?: string;
  signal?: AbortSignal;
}

/** Loads a URL in a real browser and returns the rendered DOM and its final URL. */
export async function renderPage(
  url: string,
  options: RenderOptions = {},
): Promise<{ body: string; finalUrl: string }> {
  const context = await getContext();
  const page = await context.newPage();
  try {
    await page.goto(url, {
      waitUntil: options.waitUntil ?? "networkidle",
      timeout: NAV_TIMEOUT_MS,
    });
    if (options.waitForSelector) {
      await page
        .waitForSelector(options.waitForSelector, { timeout: NAV_TIMEOUT_MS })
        .catch(() => undefined);
    }
    return { body: await page.content(), finalUrl: page.url() };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export interface CapturedResponse {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface CaptureOptions {
  /** Only responses whose URL matches are kept — the documents API, not every asset. */
  urlPattern: RegExp;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  signal?: AbortSignal;
}

/**
 * Loads a URL and returns the bodies of the network responses matching `urlPattern`.
 * Used to lift the documents listing straight out of the API a portal's SPA calls,
 * which sidesteps re-implementing its (often authenticated) request by hand — the
 * browser already carries the session.
 */
export async function capturePage(
  url: string,
  options: CaptureOptions,
): Promise<{ finalUrl: string; responses: CapturedResponse[] }> {
  const context = await getContext();
  const page = await context.newPage();
  const responses: CapturedResponse[] = [];

  page.on("response", (response) => {
    if (!options.urlPattern.test(response.url())) return;
    // Buffer the body now; it is unavailable once the page is closed.
    void response
      .text()
      .then((body) => {
        responses.push({
          url: response.url(),
          status: response.status(),
          contentType: response.headers()["content-type"] ?? "",
          body,
        });
      })
      .catch(() => undefined);
  });

  try {
    await page.goto(url, {
      waitUntil: options.waitUntil ?? "networkidle",
      timeout: NAV_TIMEOUT_MS,
    });
    // Give any late XHR triggered by the idle event a moment to settle.
    await page.waitForTimeout(500);
    return { finalUrl: page.url(), responses };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Releases the shared browser. CLI scripts call this so the event loop can drain. */
export async function closeBrowser(): Promise<void> {
  const pending = browserPromise;
  browserPromise = null;
  contextPromise = null;
  if (pending) {
    await pending.then((browser) => browser.close()).catch(() => undefined);
  }
}
