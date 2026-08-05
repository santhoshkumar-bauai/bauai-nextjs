import { ingestionEnv } from "../../config/env.ts";
import { parseEformsNotice } from "../../eforms/parse-notice.ts";
import { IngestionError, missingIdentity, permanent } from "../../http/errors.ts";
import { SourceHttpClient } from "../../http/fetch-client.ts";
import { logger } from "../../observability/logger.ts";
import type {
  DiscoveredNotice,
  DiscoveryBatch,
  DiscoveryCursor,
  RawNotice,
  SourceAccessReport,
  SourceConfigDocument,
  SourceNotice,
  TenderSourceAdapter,
} from "../../types.ts";
import { sha256 } from "../../utils/hash.ts";
import { addDays } from "../../utils/time.ts";
import { parseTedSearchHit } from "./parse-search-hit.ts";
import {
  tedSearchFields,
  type TedSearchHit,
  type TedSearchResponse,
} from "./search-fields.ts";

const log = logger.child("source.ted");

/**
 * EU TED (Tenders Electronic Daily).
 *
 * Verified against the live API on 2026-08-05:
 *   POST https://api.ted.europa.eu/v3/notices/search  — public, no credentials
 *   body: { query, fields (required), limit, paginationMode: "ITERATION" }
 *   -> { notices, totalNoticeCount, iterationNextToken }
 *   Sorting is expressed inside the query: `... SORT BY publication-date DESC`.
 *
 * `GET /v3/notices/{publicationNumber}` requires an API key, and the
 * `ted.europa.eu/.../xml` web URLs sit behind a bot challenge, so the Search API
 * response is the raw payload of record unless `TED_API_KEY` is configured.
 */
const SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search";
const NOTICE_URL = "https://api.ted.europa.eu/v3/notices";
const LICENCE = "eu-reuse-2011-833";

/**
 * TED bounds a page by `limit x fields`, not by `limit` alone:
 *
 *   HTTP 400 SEARCH_FIELDS_PER_PAGE_EXCEEDS_MAX_LIMIT
 *   "Value (11750) of parameter 'Fields per page' exceeds maximum allowed value (10000)"
 *
 * Deriving the page size from the field count keeps the largest legal page in use
 * and means adding a field later cannot silently start failing every request.
 */
const MAX_FIELDS_PER_PAGE = 10_000;
const PAGE_LIMIT = Math.max(
  1,
  Math.floor(MAX_FIELDS_PER_PAGE / tedSearchFields.length),
);

export class TedAdapter implements TenderSourceAdapter {
  readonly code = "TED" as const;
  readonly licence = LICENCE;
  readonly parserVersion = "ted-search-1.0.0";

  private readonly http: SourceHttpClient;
  private readonly config: SourceConfigDocument;

  constructor(config: SourceConfigDocument) {
    this.config = config;
    this.http = new SourceHttpClient(this.code, {
      rateLimitPerMinute: config.rateLimitPerMinute,
      maxConcurrentRequests: config.maxConcurrentRequests,
      requestTimeoutMs: config.requestTimeoutMs,
    });
  }

  async checkAccess(): Promise<SourceAccessReport> {
    try {
      const { data, meta } = await this.search("publication-date>=today(-1)", null, 1);
      return {
        source: this.code,
        reachable: true,
        httpStatus: meta.status,
        detail: `search API reachable; ${data.totalNoticeCount ?? 0} notices in the last day`,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        source: this.code,
        reachable: false,
        httpStatus: error instanceof IngestionError ? (error.httpStatus ?? null) : null,
        detail: String(error),
        checkedAt: new Date(),
      };
    }
  }

  async *discover(cursor: DiscoveryCursor): AsyncIterable<DiscoveryBatch> {
    const query = this.queryFor(cursor);
    // The iteration token is only valid for the query that produced it, so it is
    // reused only while the same window is still being paged.
    let token = cursor.mode === "live" ? null : cursor.pageOrToken;
    let page = 0;

    for (;;) {
      const { data, meta } = await this.search(query, token, PAGE_LIMIT);
      const hits = data.notices ?? [];
      page += 1;

      if (data.timedOut) {
        log.warn("TED reported a partial result; the window will be retried", { query });
      }

      const notices = hits
        .map((hit) => this.toDiscoveredNotice(hit))
        .filter((notice): notice is DiscoveredNotice => notice !== null);

      const latestPublished = notices
        .map((notice) => notice.publishedAt?.getTime() ?? 0)
        .reduce((max, value) => Math.max(max, value), 0);

      token = data.iterationNextToken ?? null;

      yield {
        notices,
        nextCursor: {
          ...cursor,
          pageOrToken: token,
          watermark: latestPublished ? new Date(latestPublished) : cursor.watermark,
          lastOfficialId: notices.at(-1)?.sourceNoticeId ?? cursor.lastOfficialId,
        },
        unchanged: notices.length === 0,
        httpStatus: meta.status,
      };

      // ITERATION mode is the documented way past the 15,000-result page-number
      // limit, so seeding a full month never needs page numbers (§9.3).
      if (!token || hits.length === 0) break;
      if (page >= 400) {
        log.warn("stopping TED pagination at the page guard", { query, page });
        break;
      }
    }
  }

  /**
   * Uses the Search API payload by default. With `TED_API_KEY` set, the official
   * per-notice XML is fetched instead, which yields the full eForms document and
   * the richer shared parser. The XML path is unverified without a key, so a
   * failure there falls back to the search payload rather than losing the notice.
   */
  async fetch(ref: DiscoveredNotice): Promise<RawNotice> {
    if (ingestionEnv.tedApiKey && ref.publicationNumber) {
      try {
        return await this.fetchOfficialXml(ref);
      } catch (error) {
        log.warn("TED XML fetch failed; falling back to the search payload", {
          publicationNumber: ref.publicationNumber,
          error: String(error),
        });
      }
    }

    if (!ref.inlinePayload) {
      throw permanent(
        `TED notice ${ref.sourceNoticeId} has no inline search payload and no API key is configured`,
      );
    }

    const { body, mimeType } = ref.inlinePayload;
    return {
      source: this.code,
      sourceNoticeId: ref.sourceNoticeId,
      body,
      mimeType,
      sha256: sha256(body),
      byteLength: body.byteLength,
      fetchedAt: new Date(),
      url: ref.url,
      licence: LICENCE,
    };
  }

  async parse(raw: RawNotice, ref: DiscoveredNotice): Promise<SourceNotice> {
    const versionKey = ref.versionKey ?? raw.sha256;

    if (raw.mimeType.includes("xml")) {
      return parseEformsNotice(raw, ref, { versionKey, discoveredUrl: ref.url });
    }
    return parseTedSearchHit(raw, ref, { versionKey, licence: LICENCE });
  }

  private async fetchOfficialXml(ref: DiscoveredNotice): Promise<RawNotice> {
    const url = `${NOTICE_URL}/${encodeURIComponent(ref.publicationNumber!)}`;
    const response = await this.http.buffer({
      url,
      headers: {
        accept: "application/xml",
        authorization: ingestionEnv.tedApiKey,
      },
    });

    if (!response.body.byteLength) {
      throw permanent(`TED returned an empty XML body for ${ref.publicationNumber}`);
    }

    return {
      source: this.code,
      sourceNoticeId: ref.sourceNoticeId,
      body: response.body,
      mimeType: "application/xml",
      sha256: sha256(response.body),
      byteLength: response.body.byteLength,
      fetchedAt: new Date(),
      url,
      licence: LICENCE,
    };
  }

  /**
   * `publication-date` is day-granular, so the overlap window is expressed in
   * whole days and exact deduplication is left to the queue's stable job keys —
   * which is the seen-ID filtering section 4 asks for.
   */
  private queryFor(cursor: DiscoveryCursor): string {
    const sort = "SORT BY publication-date DESC";

    if (cursor.mode === "backfill" || cursor.mode === "reconciliation") {
      const from = cursor.windowFrom;
      const to = cursor.windowTo;
      if (!from) {
        throw permanent(`TED ${cursor.mode} requires an explicit window`);
      }
      const upperBound = to ?? addDays(from, 1);
      return `publication-date>=${compact(from)} AND publication-date<=${compact(upperBound)} ${sort}`;
    }

    const overlapDays = Math.max(1, Math.ceil(this.config.overlapSeconds / 86_400));
    return `publication-date>=today(-${overlapDays}) ${sort}`;
  }

  private async search(query: string, token: string | null, limit: number) {
    const body: Record<string, unknown> = {
      query,
      fields: tedSearchFields,
      limit,
      paginationMode: "ITERATION",
    };
    if (token) body.iterationNextToken = token;

    return this.http.json<TedSearchResponse>({
      url: SEARCH_URL,
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
  }

  private toDiscoveredNotice(hit: TedSearchHit): DiscoveredNotice | null {
    const publicationNumber = hit["publication-number"] ?? null;
    const noticeId = hit["notice-identifier"] ?? publicationNumber;
    if (!noticeId) {
      log.warn("TED hit without an identifier; quarantined", {
        publicationNumber: publicationNumber ?? "unknown",
      });
      return null;
    }

    const payload = Buffer.from(JSON.stringify(hit), "utf8");
    const version = hit["notice-version"] != null ? String(hit["notice-version"]) : null;
    const contentHash = sha256(payload);
    const publishedAt = hit["publication-date"] ? new Date(hit["publication-date"]) : null;

    return {
      source: this.code,
      sourceNoticeId: noticeId,
      sourceVersionId: version,
      // A TED correction republishes under a new notice-version, and the content
      // hash catches silent edits that keep the same version number (§8.1).
      versionKey: version ? `${version}:${contentHash.slice(0, 12)}` : contentHash,
      publicationNumber,
      procedureId: (hit["procedure-identifier"] as string | undefined) ?? null,
      url: publicationNumber
        ? `https://ted.europa.eu/en/notice/-/detail/${publicationNumber}`
        : null,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null,
      updatedAtSource: null,
      inlinePayload: { body: payload, mimeType: "application/json" },
    };
  }
}

/** TED expects `YYYYMMDD` in date comparisons. */
function compact(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, "");
}

export function assertTedIdentity(hit: TedSearchHit): void {
  if (!hit["notice-identifier"] && !hit["publication-number"]) {
    throw missingIdentity("TED hit has no usable identity");
  }
}
