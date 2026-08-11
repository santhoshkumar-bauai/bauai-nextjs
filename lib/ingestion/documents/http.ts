import { ingestionEnv } from "../config/env.ts";
import { IngestionError, rateLimited, transientHttp } from "../http/errors.ts";
import { parseRetryAfter } from "../http/fetch-client.ts";
import { RateLimiter } from "../http/rate-limiter.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import {
  browserAvailable,
  capturePage,
  renderPage,
  type CaptureOptions,
  type RenderOptions,
} from "./browser.ts";
import type { DocumentFetcher } from "./types.ts";

const log = logger.child("documents.http");

/**
 * HTTP client for buyer portals.
 *
 * Unlike `SourceHttpClient`, which is keyed by tender source, this is keyed by
 * **host**: a single run touches dozens of unrelated portals, and each needs its own
 * budget. Limiters are created lazily and cached, so one slow portal cannot consume
 * another's allowance.
 *
 * The User-Agent is honest and identifies the crawler. Rotating user agents or
 * routing through proxies is deliberately not implemented.
 */
const USER_AGENT =
  process.env.DOCUMENTS_USER_AGENT ||
  "bau-ai-tender-documents/1.0 (+https://bau.ai; contact: santhosh@cunardai.com)";

/** Hosts that have answered with 429 or a block are backed off wholesale. */
interface HostState {
  limiter: RateLimiter;
  consecutiveFailures: number;
  blockedUntil: number;
  /** Session cookies, keyed by name. See `fetchFollowing` for why these are needed. */
  cookies: Map<string, string>;
}

const hosts = new Map<string, HostState>();

const MAX_REDIRECTS = 6;
const MAX_COOKIES_PER_HOST = 25;
/** Bounds memory when a long run touches hundreds of portals. */
const MAX_TRACKED_HOSTS = 1_000;

interface HostLimits {
  requestsPerMinutePerHost: number;
  maxConcurrentPerHost: number;
}

function hostStateFrom(
  map: Map<string, HostState>,
  host: string,
  limits: HostLimits,
): HostState {
  let state = map.get(host);
  if (!state) {
    if (map.size >= MAX_TRACKED_HOSTS) {
      // Oldest entry first; a host that has not been touched in a long time is the
      // cheapest to forget, and losing its cookies only costs one extra handshake.
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    state = {
      limiter: new RateLimiter(
        limits.requestsPerMinutePerHost,
        limits.maxConcurrentPerHost,
      ),
      consecutiveFailures: 0,
      blockedUntil: 0,
      cookies: new Map(),
    };
    map.set(host, state);
  }
  return state;
}

/**
 * Follows redirects manually, carrying cookies across every hop.
 *
 * Node's `fetch` has no cookie jar, and with `redirect: "follow"` the automatic hops
 * happen before anything can read `Set-Cookie`. Java portals commonly begin with a
 * cookie handshake — `evergabe-online.de` redirects to `?…&cookieCheck` and answers
 * **HTTP 400** unless the session cookie it just issued comes back — so without this
 * the whole platform family is unreachable. With cookies it returns the document list.
 *
 * This is ordinary session handling, not authentication: no credentials are involved.
 * Cookies are scoped by host and forgotten when the process ends. `Domain` and `Path`
 * attributes are intentionally ignored — a per-host jar is enough here and avoids
 * shipping a cookie policy engine.
 */
async function fetchFollowing(
  initialUrl: string,
  init: RequestInit,
  headers: Record<string, string>,
  stateFor: (host: string) => HostState,
): Promise<Response> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const state = stateFor(new URL(currentUrl).host);
    const cookieHeader = [...state.cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    const response = await fetch(currentUrl, {
      ...init,
      headers: cookieHeader ? { ...headers, cookie: cookieHeader } : headers,
      redirect: "manual",
    });

    captureCookies(response, state);

    const location = response.headers.get("location");
    const isRedirect = response.status >= 300 && response.status < 400 && location;
    if (!isRedirect) return response;

    // The body of a redirect is never useful and holds the connection open.
    await response.body?.cancel().catch(() => undefined);

    const next = new URL(location, currentUrl).toString();
    if (next === currentUrl) return response;
    currentUrl = next;

    // A 303, or a 301/302 after POST, must continue as GET without the body. GET and
    // HEAD are unaffected; a POST that redirects is downgraded here.
    if (init.method === "POST") {
      init = { ...init, method: "GET", body: undefined };
    }
  }

  throw transientHttp(`${initialUrl} exceeded ${MAX_REDIRECTS} redirects`, 310);
}

function captureCookies(response: Response, state: HostState): void {
  const setCookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter((value): value is string =>
          Boolean(value),
        );

  for (const cookie of setCookies) {
    const [pair] = cookie.split(";");
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!name) continue;

    if (state.cookies.size >= MAX_COOKIES_PER_HOST && !state.cookies.has(name)) continue;
    state.cookies.set(name, value);
  }
}

export interface DownloadResult {
  body: Buffer;
  mimeType: string;
  /** From `Content-Disposition`, else the URL path. */
  fileName: string;
  finalUrl: string;
  status: number;
}

export interface DocumentHttpOptions {
  /**
   * Overrides the shared per-host budget with a private, faster one — used by
   * the on-demand fetch where a user is actively waiting. A client without
   * overrides shares the module-wide host state (limits, backoff, cookies)
   * with every other default client in the process.
   */
  requestsPerMinutePerHost?: number;
  maxConcurrentPerHost?: number;
}

export class DocumentHttpClient implements DocumentFetcher {
  /**
   * Present only when the headless browser is available, so `http.render?.(…)` in a
   * resolver is a genuine capability check rather than an always-true one.
   */
  render?: DocumentFetcher["render"];
  capture?: DocumentFetcher["capture"];

  private readonly limits: HostLimits;
  private readonly hosts: Map<string, HostState>;

  constructor(options: DocumentHttpOptions = {}) {
    const custom =
      options.requestsPerMinutePerHost !== undefined ||
      options.maxConcurrentPerHost !== undefined;
    this.limits = {
      requestsPerMinutePerHost:
        options.requestsPerMinutePerHost ??
        ingestionEnv.documents.requestsPerMinutePerHost,
      maxConcurrentPerHost:
        options.maxConcurrentPerHost ?? ingestionEnv.documents.maxConcurrentPerHost,
    };
    // A custom budget gets its own host map so its limiters cannot be diluted
    // by (or dilute) the shared crawl budget. Backoff and cookies are then
    // per-client too, which is fine for a short-lived on-demand run.
    this.hosts = custom ? new Map() : hosts;

    if (browserAvailable()) {
      this.render = (url, options) => this.renderUnderLimit(url, options);
      this.capture = (url, options) => this.captureUnderLimit(url, options);
    }
  }

  private hostState(host: string): HostState {
    return hostStateFrom(this.hosts, host, this.limits);
  }

  /** Runs a browser navigation under the same per-host slot as an HTTP request. */
  private async renderUnderLimit(
    url: string,
    options?: RenderOptions,
  ): Promise<{ body: string; finalUrl: string }> {
    return this.withHostSlot(url, options?.signal, () => renderPage(url, options));
  }

  private async captureUnderLimit(
    url: string,
    options: CaptureOptions,
  ): Promise<Awaited<ReturnType<typeof capturePage>>> {
    return this.withHostSlot(url, options.signal, () => capturePage(url, options));
  }

  private async withHostSlot<T>(
    url: string,
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    const host = new URL(url).host;
    const state = this.hostState(host);
    if (state.blockedUntil > Date.now()) {
      throw rateLimited(`${host} is backed off`, state.blockedUntil - Date.now());
    }
    const release = await state.limiter.acquire(signal);
    try {
      return await run();
    } finally {
      release();
    }
  }

  /** Fetches a page as text, following redirects. */
  async html(url: string, signal?: AbortSignal): Promise<{ body: string; finalUrl: string }> {
    const response = await this.request(url, "GET", signal, {
      accept: "text/html,application/xhtml+xml",
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!/html|xml|text/i.test(contentType)) {
      throw new IngestionError(
        `Expected HTML from ${url} but received ${contentType}`,
        "MALFORMED_PAYLOAD",
        { retryable: false },
      );
    }

    return { body: await response.text(), finalUrl: response.url };
  }

  async head(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; mimeType: string; byteLength: number | null }> {
    // Some portals reject HEAD outright; a failed probe must not fail the document,
    // so the caller falls back to a ranged GET.
    const response = await this.request(url, "HEAD", signal, {});
    const length = response.headers.get("content-length");
    return {
      status: response.status,
      mimeType: (response.headers.get("content-type") ?? "").split(";")[0].trim(),
      byteLength: length ? Number.parseInt(length, 10) : null,
    };
  }

  /**
   * Downloads a file, refusing anything over the size cap. The cap is enforced from
   * `Content-Length` when present and again while reading, because a portal may omit
   * or understate the header.
   */
  async download(
    url: string,
    signal?: AbortSignal,
    referer?: string,
  ): Promise<DownloadResult> {
    const response = await this.request(url, "GET", signal, {
      accept: "*/*",
      ...(referer ? { referer } : {}),
    });

    const max = ingestionEnv.documents.maxFileBytes;
    const declared = response.headers.get("content-length");
    if (declared && Number.parseInt(declared, 10) > max) {
      throw new IngestionError(
        `${url} declares ${declared} bytes, over the ${max} byte cap`,
        "PERMANENT",
        { retryable: false },
      );
    }

    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();

    if (reader) {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          // Portals serving large archives drop the connection mid-body, which
          // surfaces as a bare `TypeError: terminated`. Unclassified it counted as a
          // permanent failure, so a 90 MB tender pack was abandoned on one blip.
          // It is transient: the next attempt usually completes.
          throw transientHttp(
            `${url} connection dropped after ${total} bytes: ${String(error)}`,
            0,
            error,
          );
        }

        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => undefined);
          throw new IngestionError(
            `${url} exceeded the ${max} byte cap while downloading`,
            "PERMANENT",
            { retryable: false },
          );
        }
        chunks.push(Buffer.from(chunk.value));
      }
    }

    const body = Buffer.concat(chunks);
    const contentType = (response.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0]
      .trim();

    return {
      body,
      mimeType: contentType,
      fileName: fileNameFrom(response, url),
      finalUrl: response.url,
      status: response.status,
    };
  }

  /**
   * Submits a form (default `application/x-www-form-urlencoded`) and returns the page
   * it produces. Uses the per-host cookie jar, so a session opened by a prior `html()`
   * GET is present on the POST — which is how a two-step "choose how to download" flow
   * (Staatsanzeiger) reaches the archive link.
   */
  async post(
    url: string,
    form: Record<string, string> | string,
    signal?: AbortSignal,
  ): Promise<{ body: string; finalUrl: string; status: number }> {
    const body =
      typeof form === "string" ? form : new URLSearchParams(form).toString();
    const response = await this.request(url, "POST", signal, {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml",
    }, body);
    return { body: await response.text(), finalUrl: response.url, status: response.status };
  }

  private async request(
    url: string,
    method: "GET" | "HEAD" | "POST",
    signal: AbortSignal | undefined,
    extraHeaders: Record<string, string>,
    body?: string,
  ): Promise<Response> {
    const host = new URL(url).host;
    const state = this.hostState(host);

    if (state.blockedUntil > Date.now()) {
      const waitMs = state.blockedUntil - Date.now();
      throw rateLimited(`${host} is backed off for another ${waitMs}ms`, waitMs);
    }

    const release = await state.limiter.acquire(signal);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      ingestionEnv.documents.requestTimeoutMs,
    );
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    const startedAt = Date.now();
    try {
      const response = await fetchFollowing(
        url,
        { method, signal: controller.signal, ...(body !== undefined ? { body } : {}) },
        {
          "user-agent": USER_AGENT,
          "accept-language": "de-DE,de;q=0.9,en;q=0.8",
          ...extraHeaders,
        },
        (redirectHost) => this.hostState(redirectHost),
      );

      metrics.observe("ingestion_document_request_ms", Date.now() - startedAt, {
        host,
        status: String(response.status),
      });

      if (response.status === 429 || response.status === 503) {
        const retryAfter =
          parseRetryAfter(response.headers.get("retry-after")) ?? 5 * 60_000;
        state.consecutiveFailures += 1;
        state.blockedUntil = Date.now() + retryAfter;
        log.warn("portal asked us to slow down", {
          host,
          status: response.status,
          backoffMs: retryAfter,
        });
        throw rateLimited(`${host} returned HTTP ${response.status}`, retryAfter);
      }

      if (response.status === 403) {
        // A block, not a missing page. Backing the whole host off protects the rest
        // of the run from burning attempts against a portal that is refusing us.
        state.consecutiveFailures += 1;
        state.blockedUntil = Date.now() + 15 * 60_000;
        throw new IngestionError(`${host} refused the request (HTTP 403)`, "PERMANENT", {
          retryable: false,
          httpStatus: 403,
        });
      }

      if (response.status >= 500 || response.status === 408) {
        state.consecutiveFailures += 1;
        throw transientHttp(`${url} returned HTTP ${response.status}`, response.status);
      }

      if (!response.ok) {
        throw new IngestionError(`${url} returned HTTP ${response.status}`, "PERMANENT", {
          retryable: false,
          httpStatus: response.status,
        });
      }

      state.consecutiveFailures = 0;
      return response;
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      const aborted = controller.signal.aborted && !signal?.aborted;
      throw transientHttp(
        aborted
          ? `${url} timed out after ${ingestionEnv.documents.requestTimeoutMs}ms`
          : `${url} failed: ${String(error)}`,
        aborted ? 408 : 0,
        error,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      release();
    }
  }
}

/** Prefers the portal's stated filename, falling back to the URL path. */
function fileNameFrom(response: Response, url: string): string {
  const disposition = response.headers.get("content-disposition");
  if (disposition) {
    const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    if (utf8?.[1]) {
      try {
        return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ""));
      } catch {
        // Fall through to the plain filename parameter.
      }
    }
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    if (plain?.[1]) return plain[1].trim();
  }

  const path = new URL(response.url || url).pathname;
  const last = path.split("/").filter(Boolean).pop();
  return last && last.includes(".") ? decodeURIComponent(last) : "document";
}

/** Test seam and operational reset; clears per-host limiters and backoff. */
export function resetHostState(): void {
  hosts.clear();
}
