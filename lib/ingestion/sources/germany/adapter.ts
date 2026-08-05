import { Readable } from "node:stream";

import { SourceHttpClient } from "../../http/fetch-client.ts";
import { IngestionError, missingIdentity, permanent } from "../../http/errors.ts";
import { parseEformsNotice } from "../../eforms/parse-notice.ts";
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
import { toDayKey, toMonthKey } from "../../utils/time.ts";
import { forEachZipEntry } from "../../utils/zip.ts";

const log = logger.child("source.de");

/**
 * Germany Public Procurement Data Service (oeffentlichevergabe.de).
 *
 * Verified against the live service and its OpenAPI document on 2026-08-05:
 *   GET /api/notice-exports?pubDay=YYYY-MM-DD | pubMonth=YYYY-MM
 *   Accept: application/vnd.bekanntmachungsservice.eforms.zip+zip
 *   -> 200, ETag: "version-<n>", ZIP of one eForms XML per notice
 *
 * Two verified constraints shape this adapter, and both differ from the plan in
 * the architecture document:
 *
 *  1. `pubDay` MUST be in the past. Requesting today returns
 *     `HTTP 400 The specified pubDay exceeds the allowed range. It must lie in the
 *     past.` The current month's `pubMonth` export likewise ends at yesterday.
 *     So section 4's "check the current pubDay every 5 minutes" is not possible:
 *     the freshest data this source offers is the previous publication day.
 *     Live polling therefore watches yesterday and the day before, which is what
 *     actually detects new German notices as early as the source allows.
 *
 *  2. The service exposes no incremental or changed-since parameter — the OpenAPI
 *     document lists only `pubMonth`, `pubDay`, and `format` — so the ETag is the
 *     only way to avoid reprocessing. Yesterday's archive is amended during the
 *     day as notices are supplied, and the ETag (`version-<n>`) changes with it,
 *     which is why a 5-minute conditional poll is still worthwhile.
 *
 * The practical consequence for section 15.1: Germany cannot meet a
 * source-publication-to-app latency SLO of 5 minutes. Its SLO must be measured
 * from source availability, and the source itself lags by about a day.
 */
const BASE_URL = "https://oeffentlichevergabe.de/api/notice-exports";
const EFORMS_ACCEPT = "application/vnd.bekanntmachungsservice.eforms.zip+zip";
const LICENCE = "dl-de-by-2.0";

export class GermanyAdapter implements TenderSourceAdapter {
  readonly code = "DE_BUND" as const;
  readonly licence = LICENCE;
  readonly parserVersion = "eforms-de-1.0.0";

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
    // Yesterday, not today: today is rejected with HTTP 400 by design.
    const day = toDayKey(mostRecentAvailableDay());
    try {
      const response = await this.http.buffer({
        url: `${BASE_URL}?pubDay=${day}`,
        headers: { accept: EFORMS_ACCEPT },
        timeoutMs: 30_000,
      });
      return {
        source: this.code,
        reachable: true,
        httpStatus: response.status,
        detail: `eForms export for ${day} is ${response.body.byteLength} bytes (etag ${response.etag ?? "none"})`,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        source: this.code,
        reachable: false,
        httpStatus: null,
        detail: String(error),
        checkedAt: new Date(),
      };
    }
  }

  /**
   * The source publishes whole-day archives rather than an incremental feed, so
   * discovery is: request the day, stop immediately if the ETag is unchanged,
   * otherwise stream the archive and emit one job per contained notice.
   */
  async *discover(cursor: DiscoveryCursor): AsyncIterable<DiscoveryBatch> {
    for (const partition of this.partitionsFor(cursor)) {
      // Validators only apply while re-polling the same partition; a new day
      // must never be skipped because yesterday's ETag still matches.
      const reuseValidators = cursor.pageOrToken === partition;

      let response: Awaited<ReturnType<SourceHttpClient["stream"]>>;
      try {
        response = await this.http.stream({
          url: `${BASE_URL}?${partition}`,
          headers: { accept: EFORMS_ACCEPT },
          etag: reuseValidators ? cursor.etag : null,
          lastModified: reuseValidators ? cursor.lastModified : null,
        });
      } catch (error) {
        // Defence in depth around the "must lie in the past" rule: a partition
        // that is out of range is skipped, not treated as a source failure that
        // would open the circuit breaker.
        if (isOutOfRange(error)) {
          log.warn("partition not yet available at the source", { partition });
          yield {
            notices: [],
            nextCursor: cursor,
            unchanged: true,
            httpStatus: 400,
          };
          continue;
        }
        throw error;
      }

      if (response.notModified || !response.stream) {
        log.debug("partition unchanged", { partition, etag: cursor.etag });
        yield {
          notices: [],
          nextCursor: { ...cursor, pageOrToken: partition },
          unchanged: true,
          httpStatus: response.status,
        };
        continue;
      }

      const notices: DiscoveredNotice[] = [];
      const archive = await forEachZipEntry(
        response.stream as Readable,
        async (entry) => {
          const discovered = this.toDiscoveredNotice(entry.path, entry.body);
          if (discovered) notices.push(discovered);
        },
        { include: (path) => path.toLowerCase().endsWith(".xml") },
      );

      log.info("partition discovered", {
        partition,
        entries: archive.entryCount,
        notices: notices.length,
        skipped: archive.skipped,
      });

      const latestPublished = notices
        .map((notice) => notice.publishedAt?.getTime() ?? 0)
        .reduce((max, value) => Math.max(max, value), 0);

      yield {
        notices,
        nextCursor: {
          ...cursor,
          pageOrToken: partition,
          etag: response.etag,
          lastModified: response.lastModified,
          watermark: latestPublished ? new Date(latestPublished) : cursor.watermark,
          lastOfficialId: notices.at(-1)?.sourceNoticeId ?? cursor.lastOfficialId,
        },
        unchanged: false,
        httpStatus: response.status,
        archive: {
          checksum: archive.archiveSha256,
          byteLength: archive.archiveByteLength,
          entryCount: archive.entryCount,
        },
      };
    }
  }

  /**
   * Notices always arrive inline inside the day archive, so a separate fetch is
   * only ever a bug: refetching one notice would mean downloading the whole
   * archive again.
   */
  async fetch(ref: DiscoveredNotice): Promise<RawNotice> {
    if (!ref.inlinePayload) {
      throw permanent(
        `${this.code} notice ${ref.sourceNoticeId} has no inline payload; German notices are only distributed inside day archives`,
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
    return parseEformsNotice(raw, ref, {
      versionKey: ref.versionKey ?? raw.sha256,
      discoveredUrl: ref.url,
    });
  }

  /**
   * Builds the request partitions for a mode. Every `pubDay` produced here is
   * strictly in the past, because the service rejects today outright.
   *
   * Backfill uses monthly exports, per section 9.3. Reconciliation re-reads the
   * configured trailing window. Live watches the two most recent available days:
   * yesterday, which is still being amended, and the day before, to catch a late
   * supply that arrived after the first archive was considered settled.
   */
  private partitionsFor(cursor: DiscoveryCursor): string[] {
    if (cursor.mode === "backfill") {
      if (!cursor.windowFrom) {
        throw permanent(`${this.code} backfill requires an explicit window`);
      }
      // A whole month in one request; the service exposes pubMonth for this.
      return [`pubMonth=${toMonthKey(cursor.windowFrom)}`];
    }

    const latest = mostRecentAvailableDay();

    if (cursor.mode === "reconciliation") {
      const days = Math.max(1, this.config.reconciliationDays);
      const partitions: string[] = [];
      for (let offset = 0; offset < days; offset += 1) {
        partitions.push(
          `pubDay=${toDayKey(new Date(latest.getTime() - offset * 86_400_000))}`,
        );
      }
      return partitions;
    }

    return [
      `pubDay=${toDayKey(latest)}`,
      `pubDay=${toDayKey(new Date(latest.getTime() - 86_400_000))}`,
    ];
  }

  /**
   * Archive members are named `<notice-uuid>-<version>.xml`, which supplies both
   * the stable notice id and the official version without parsing the XML. The
   * content hash still becomes part of the version key so a silently corrected
   * republication under the same version is treated as a new version (§8.1).
   */
  private toDiscoveredNotice(entryPath: string, body: Buffer): DiscoveredNotice | null {
    const fileName = entryPath.split("/").pop() ?? entryPath;
    const match = /^(.+?)-(\d+)\.xml$/i.exec(fileName);

    const sourceNoticeId = match?.[1] ?? fileName.replace(/\.xml$/i, "");
    if (!sourceNoticeId) {
      log.warn("archive entry without a usable notice id; quarantined", { entryPath });
      return null;
    }

    const versionId = match?.[2] ?? null;
    const contentHash = sha256(body);

    return {
      source: this.code,
      sourceNoticeId,
      sourceVersionId: versionId,
      versionKey: versionId ? `${versionId}:${contentHash.slice(0, 12)}` : contentHash,
      publicationNumber: null,
      procedureId: null,
      url: `https://oeffentlichevergabe.de/ui/de/bekanntmachung/${sourceNoticeId}`,
      publishedAt: null,
      updatedAtSource: null,
      inlinePayload: { body, mimeType: "application/xml" },
    };
  }
}

/**
 * The newest publication day the service will serve: yesterday.
 *
 * Computed in UTC while the service operates on Europe/Berlin, which is UTC+1 or
 * UTC+2. Berlin's date is therefore never behind UTC's, so "yesterday in UTC" is
 * always strictly in the past in Berlin too — the comparison the API enforces.
 */
function mostRecentAvailableDay(now = new Date()): Date {
  return new Date(now.getTime() - 86_400_000);
}

/** The documented rejection for a `pubDay` that is not yet in the past. */
function isOutOfRange(error: unknown): boolean {
  return (
    error instanceof IngestionError &&
    error.httpStatus === 400 &&
    /must lie in the past|exceeds the allowed range/i.test(error.message)
  );
}

export function assertGermanNoticeId(id: string): void {
  if (!id.trim()) throw missingIdentity("German notice id is empty");
}
