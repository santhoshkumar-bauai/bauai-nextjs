import { Readable } from "node:stream";

import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { TenderSourceCode } from "../types.ts";
import {
  authenticationFailure,
  IngestionError,
  rateLimited,
  transientHttp,
} from "./errors.ts";
import { RateLimiter } from "./rate-limiter.ts";

const log = logger.child("http");

const USER_AGENT =
  process.env.INGESTION_USER_AGENT ||
  "bau-ai-tender-ingestion/1.0 (+https://bau.ai; contact: santhosh@cunardai.com)";

export interface ConditionalRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Sent as `If-None-Match`; a 304 means the archive is unchanged (§4.1). */
  etag?: string | null;
  lastModified?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  /** True when the source answered 304 and no body was transferred. */
  notModified: boolean;
  etag: string | null;
  lastModified: string | null;
  contentType: string;
  contentLength: number | null;
  headers: Headers;
}

export interface BufferedResponse extends HttpResponse {
  body: Buffer;
}

export interface StreamedResponse extends HttpResponse {
  stream: Readable | null;
}

export interface SourceHttpOptions {
  rateLimitPerMinute: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
}

export class SourceHttpClient {
  private readonly source: TenderSourceCode;
  private readonly limiter: RateLimiter;
  private readonly defaultTimeoutMs: number;

  constructor(source: TenderSourceCode, options: SourceHttpOptions) {
    this.source = source;
    this.limiter = new RateLimiter(
      options.rateLimitPerMinute,
      options.maxConcurrentRequests,
    );
    this.defaultTimeoutMs = options.requestTimeoutMs;
  }

  /** Streams the response so large archives never sit in memory whole (§14). */
  async stream(request: ConditionalRequest): Promise<StreamedResponse> {
    const { response, release, startedAt } = await this.send(request);
    try {
      const meta = this.describe(response);
      if (meta.notModified || !response.body) {
        return { ...meta, stream: null };
      }
      const stream = Readable.fromWeb(response.body as never);
      // The rate-limit slot is held until the body is fully consumed, otherwise
      // concurrency would be measured on headers rather than on real transfer.
      stream.once("close", release);
      stream.once("error", release);
      this.record(request, meta.status, startedAt);
      return { ...meta, stream };
    } catch (error) {
      release();
      throw error;
    }
  }

  async buffer(request: ConditionalRequest): Promise<BufferedResponse> {
    const { response, release, startedAt } = await this.send(request);
    try {
      const meta = this.describe(response);
      const body = meta.notModified
        ? Buffer.alloc(0)
        : Buffer.from(await response.arrayBuffer());
      this.record(request, meta.status, startedAt);
      return { ...meta, body };
    } finally {
      release();
    }
  }

  async json<T>(request: ConditionalRequest): Promise<{ data: T; meta: HttpResponse }> {
    const response = await this.buffer(request);
    if (response.notModified) {
      return { data: undefined as T, meta: response };
    }
    try {
      return { data: JSON.parse(response.body.toString("utf8")) as T, meta: response };
    } catch (error) {
      throw new IngestionError(
        `${this.source} returned unparseable JSON from ${request.url}`,
        "MALFORMED_PAYLOAD",
        { retryable: false, cause: error },
      );
    }
  }

  private async send(request: ConditionalRequest) {
    const release = await this.limiter.acquire(request.signal);
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "accept-encoding": "gzip, deflate",
      ...request.headers,
    };
    if (request.etag) headers["if-none-match"] = request.etag;
    if (request.lastModified) headers["if-modified-since"] = request.lastModified;

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method ?? "GET",
        headers,
        body: request.body,
        signal: controller.signal,
        redirect: "follow",
      });
    } catch (error) {
      release();
      metrics.increment("ingestion_http_errors_total", {
        source: this.source,
        kind: "network",
      });
      const aborted = controller.signal.aborted && !request.signal?.aborted;
      throw transientHttp(
        aborted
          ? `${this.source} request to ${request.url} timed out after ${timeoutMs}ms`
          : `${this.source} request to ${request.url} failed: ${String(error)}`,
        aborted ? 408 : 0,
        error,
      );
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok && response.status !== 304) {
      const detail = await this.readErrorDetail(response);
      release();
      throw this.classify(response, request.url, detail);
    }

    return { response, release, startedAt };
  }

  /**
   * Official APIs explain their rejections in the response body — TED names the
   * offending parameter, the German service states its date rule. Discarding that
   * turns a one-line fix into a debugging session, so a capped excerpt is folded
   * into the error message.
   */
  private async readErrorDetail(response: Response): Promise<string> {
    try {
      const text = await response.text();
      const collapsed = text.replace(/\s+/g, " ").trim();
      return collapsed ? `: ${collapsed.slice(0, 500)}` : "";
    } catch {
      return "";
    }
  }

  /** Maps status codes onto the section 11.1 retry table. */
  private classify(response: Response, url: string, detail = ""): IngestionError {
    const { status } = response;
    metrics.increment("ingestion_http_errors_total", {
      source: this.source,
      kind: String(status),
    });

    if (status === 429) {
      const retryAfter = response.headers.get("retry-after");
      return rateLimited(
        `${this.source} rate limited on ${url}${detail}`,
        parseRetryAfter(retryAfter),
      );
    }
    if (status === 401 || status === 403) {
      return authenticationFailure(
        `${this.source} rejected credentials for ${url} (HTTP ${status})${detail}`,
        status,
      );
    }
    if (status === 408 || status >= 500) {
      return transientHttp(
        `${this.source} returned HTTP ${status} for ${url}${detail}`,
        status,
      );
    }
    return new IngestionError(
      `${this.source} returned HTTP ${status} for ${url}${detail}`,
      "PERMANENT",
      { retryable: false, httpStatus: status },
    );
  }

  private describe(response: Response): HttpResponse {
    const contentLength = response.headers.get("content-length");
    return {
      status: response.status,
      notModified: response.status === 304,
      etag: response.headers.get("etag"),
      lastModified: response.headers.get("last-modified"),
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      contentLength: contentLength ? Number.parseInt(contentLength, 10) : null,
      headers: response.headers,
    };
  }

  private record(request: ConditionalRequest, status: number, startedAt: number): void {
    const durationMs = Date.now() - startedAt;
    metrics.observe("ingestion_http_request_duration_ms", durationMs, {
      source: this.source,
      status: String(status),
    });
    log.debug("source request", {
      source: this.source,
      url: request.url,
      status,
      durationMs,
    });
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds) && String(seconds) === value.trim()) {
    return seconds * 1_000;
  }
  const date = new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return undefined;
}
