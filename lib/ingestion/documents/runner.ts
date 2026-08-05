import { ingestionEnv } from "../config/env.ts";
import { IngestionError } from "../http/errors.ts";
import { describeError, logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import { recordDeadLetter } from "../pipeline/dead-letter.ts";
import { forEachZipEntry } from "../utils/zip.ts";
import { exponentialBackoffMs, sleep } from "../utils/time.ts";
import { parseRetryAfterFallback } from "../worker/retry-policy.ts";
import { DocumentHttpClient, type DownloadResult } from "./http.ts";
import { documentStore } from "./records.ts";
import { hasPlatformResolver, resolverFor } from "./registry.ts";
import { storeDocumentFile, storeDocumentText } from "./store.ts";
import { canExtractText, extractText } from "./text-extract.ts";
import {
  isSkip,
  type DocumentSkipReason,
  type FailedDocumentFile,
  type ResolvedFile,
  type StoredDocumentFile,
  type TenderDocumentRecord,
} from "./types.ts";

const log = logger.child("documents.runner");

const ZIP_TYPES = /^application\/(zip|x-zip-compressed|octet-stream)$/i;

export interface DocumentRunCounters {
  claimed: number;
  fetched: number;
  files: number;
  /** Individual files that failed even though their row may have succeeded. */
  filesFailed: number;
  skipped: number;
  failed: number;
  bytes: number;
}

export function emptyDocumentCounters(): DocumentRunCounters {
  return { claimed: 0, fetched: 0, files: 0, filesFailed: 0, skipped: 0, failed: 0, bytes: 0 };
}

export interface DocumentRunOptions {
  /** Stop after this many document rows. `null` drains the queue. */
  limit: number | null;
  concurrency: number;
  /** Restrict to one host, which is how a new resolver gets exercised in isolation. */
  host?: string;
  signal?: AbortSignal;
  counters?: DocumentRunCounters;
  /** Return once the queue is empty instead of waiting for more work. */
  exitWhenDrained: boolean;
}

/**
 * Drains the `tender_documents` work list.
 *
 * MongoDB is the queue rather than Redis, which is what lets the seeder run this
 * without any broker. Rows are claimed with a lease and heartbeat, mirroring the
 * pattern proven in `seed/partitions.ts`, so a killed process releases its work
 * instead of stranding it.
 */
export async function runDocumentFetch(
  options: DocumentRunOptions,
): Promise<DocumentRunCounters> {
  const counters = options.counters ?? emptyDocumentCounters();
  const http = new DocumentHttpClient();

  await releaseStaleLeases();

  const workers = Array.from({ length: Math.max(1, options.concurrency) }, () =>
    worker(http, options, counters),
  );
  await Promise.all(workers);

  return counters;
}

async function worker(
  http: DocumentHttpClient,
  options: DocumentRunOptions,
  counters: DocumentRunCounters,
): Promise<void> {
  for (;;) {
    if (options.signal?.aborted) return;
    if (options.limit !== null && counters.claimed >= options.limit) return;

    const row = await claimNext(options.host);
    if (!row) {
      if (options.exitWhenDrained) return;
      await sleep(ingestionEnv.documents.pollIntervalMs, options.signal);
      continue;
    }

    counters.claimed += 1;
    const heartbeat = setInterval(() => {
      void touchLease(row._id).catch(() => undefined);
    }, Math.max(30_000, Math.floor(ingestionEnv.documents.leaseTtlMs / 4)));

    try {
      await processRow(row, http, counters, options.signal);
    } catch (error) {
      await recordFailure(row, error, counters);
    } finally {
      clearInterval(heartbeat);
    }
  }
}

async function processRow(
  row: TenderDocumentRecord,
  http: DocumentHttpClient,
  counters: DocumentRunCounters,
  signal?: AbortSignal,
): Promise<void> {
  const url = new URL(row.sourceUrl);
  const resolver = resolverFor(url);
  const startedAt = Date.now();

  const outcome = await resolver.resolve({ url, http, signal });

  metrics.increment("ingestion_document_resolve_total", {
    host: row.host,
    platform: resolver.platform,
    outcome: isSkip(outcome) ? outcome.skip : "files",
  });

  if (isSkip(outcome)) {
    // An unknown host that yielded nothing is reported as an unwritten resolver
    // rather than an empty portal, because that is the actionable difference.
    const reason: DocumentSkipReason =
      outcome.skip === "NO_FILES_FOUND" && !hasPlatformResolver(url)
        ? "UNSUPPORTED_PLATFORM"
        : outcome.skip;

    await markSkipped(row, reason, resolver.platform, outcome.detail);
    counters.skipped += 1;
    return;
  }

  const files = outcome.files.slice(0, ingestionEnv.documents.maxFilesPerTender);
  if (files.length < outcome.files.length) {
    log.warn("document list truncated", {
      host: row.host,
      found: outcome.files.length,
      kept: files.length,
    });
  }

  const stored: StoredDocumentFile[] = [];
  const failed: FailedDocumentFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (signal?.aborted) break;
    if (totalBytes >= ingestionEnv.documents.maxTotalBytesPerTender) {
      log.warn("tender document budget exhausted", {
        canonicalKey: row.canonicalKey,
        totalBytes,
      });
      // Recorded rather than dropped, so the audit trail shows the budget stopped
      // these files rather than the portal refusing them.
      failed.push({
        url: file.url,
        fileName: file.fileName ?? null,
        label: file.label ?? null,
        errorClass: "TENDER_BUDGET_EXHAUSTED",
        error: `Stopped after ${totalBytes} bytes for this tender`,
        retryable: false,
        attemptedAt: new Date(),
      });
      continue;
    }

    try {
      const results = await fetchAndStore(row, file, http, signal);
      for (const result of results) {
        stored.push(result);
        totalBytes += result.byteLength;
      }
    } catch (error) {
      // One bad file must not fail the document — the others are still archived — but
      // it must still be recorded, or a partial success would look like a full one.
      const described = describeError(error);
      failed.push({
        url: file.url,
        fileName: file.fileName ?? null,
        label: file.label ?? null,
        errorClass: error instanceof IngestionError ? error.failureClass : described.name,
        error: described.message.slice(0, 600),
        retryable: error instanceof IngestionError ? error.retryable : true,
        attemptedAt: new Date(),
      });
      log.warn("file could not be retrieved", {
        url: file.url,
        error: described.message.slice(0, 200),
      });
      metrics.increment("ingestion_document_file_failures_total", {
        host: row.host,
        errorClass: error instanceof IngestionError ? error.failureClass : described.name,
      });
    }
  }

  if (!stored.length) {
    await markSkipped(
      row,
      "NO_FILES_FOUND",
      resolver.platform,
      failed.length
        ? `all ${failed.length} file download(s) failed: ${failed[0].errorClass}`
        : "resolver returned no files",
      failed,
    );
    counters.skipped += 1;
    return;
  }

  const store = await documentStore();
  await store.updateOne(
    { _id: row._id },
    {
      $set: {
        status: "FETCHED",
        skipReason: null,
        platform: resolver.platform,
        files: stored,
        failedFiles: failed,
        error: null,
        resolvedAt: new Date(),
        leaseOwner: null,
        heartbeatAt: null,
        updatedAt: new Date(),
      },
    },
  );

  counters.fetched += 1;
  counters.files += stored.length;
  counters.filesFailed += failed.length;
  counters.bytes += totalBytes;

  metrics.observe("ingestion_document_row_ms", Date.now() - startedAt, {
    host: row.host,
  });
  log.info("documents stored", {
    canonicalKey: row.canonicalKey,
    host: row.host,
    files: stored.length,
    failedFiles: failed.length,
    bytes: totalBytes,
  });
}

/**
 * Downloads one resolved file. A ZIP is unpacked and its members stored
 * individually, because a bidder wants the drawings and the specification, not a
 * bundle they must download and open to see inside.
 */
async function fetchAndStore(
  row: TenderDocumentRecord,
  file: ResolvedFile,
  http: DocumentHttpClient,
  signal?: AbortSignal,
): Promise<StoredDocumentFile[]> {
  const download = await http.download(file.url, signal, file.referer);
  const fileName = file.fileName ?? download.fileName;

  // A link can match the download heuristics and still serve a web page — an
  // `?detail=` listing on `enportal.de` did exactly that, and without this guard its
  // 339 KB of HTML was archived as though it were a tender document. Storing pages
  // would quietly fill the bucket with navigation markup and give search 300k
  // characters of menu text per tender.
  if (isHtmlResponse(download.mimeType) && !hasDocumentExtension(fileName)) {
    log.debug("link resolved to a page, not a document; ignoring", {
      url: file.url,
      mimeType: download.mimeType,
    });
    return [];
  }

  if (isZip(download, fileName)) {
    return unpackZip(row, file, download, signal);
  }

  return [await persist(row, file.url, fileName, download.body, download.mimeType)];
}

function isHtmlResponse(mimeType: string): boolean {
  return /^(text\/html|application\/xhtml\+xml)$/i.test(mimeType.split(";")[0].trim());
}

/**
 * Whether the name itself claims to be a document. A portal that serves a real file
 * with an HTML content type is rare but happens, so an explicit extension still wins.
 */
function hasDocumentExtension(fileName: string): boolean {
  return /\.(pdf|zip|7z|rar|docx?|xlsx?|pptx?|odt|ods|odp|rtf|txt|csv|dwg|dxf|ifc)$/i.test(
    fileName,
  );
}

function isZip(download: DownloadResult, fileName: string): boolean {
  if (/\.zip$/i.test(fileName)) return true;
  if (!ZIP_TYPES.test(download.mimeType)) return false;
  // `application/octet-stream` is ambiguous, so confirm by the local file header.
  return download.body.subarray(0, 2).toString("latin1") === "PK";
}

async function unpackZip(
  row: TenderDocumentRecord,
  file: ResolvedFile,
  download: DownloadResult,
  signal?: AbortSignal,
): Promise<StoredDocumentFile[]> {
  const { Readable } = await import("node:stream");
  const stored: StoredDocumentFile[] = [];

  // Reuses the archive reader already hardened against path traversal and
  // decompression bombs for source packages.
  await forEachZipEntry(Readable.from(download.body), async (entry) => {
    if (signal?.aborted) return;
    if (stored.length >= ingestionEnv.documents.maxFilesPerTender) return;

    const result = await persist(
      row,
      file.url,
      entry.path.split("/").pop() || "document",
      entry.body,
      guessMimeType(entry.path),
      entry.path,
    );
    stored.push(result);
  });

  log.debug("zip unpacked", { url: file.url, members: stored.length });
  return stored;
}

async function persist(
  row: TenderDocumentRecord,
  sourceUrl: string,
  fileName: string,
  body: Buffer,
  mimeType: string,
  archivePath?: string,
): Promise<StoredDocumentFile> {
  const object = await storeDocumentFile({
    canonicalKey: row.canonicalKey,
    fileName,
    body,
    mimeType,
    sourceUrl,
  });

  const record: StoredDocumentFile = {
    url: sourceUrl,
    fileName,
    mimeType,
    byteLength: body.byteLength,
    sha256: object.sha256,
    s3: { bucket: object.bucket, key: object.key },
    textStatus: "PENDING",
    textChars: 0,
    textS3Key: null,
    text: null,
  };
  if (archivePath) record.archivePath = archivePath;

  if (!canExtractText(mimeType, fileName)) {
    record.textStatus = "UNSUPPORTED";
    return record;
  }

  const extracted = await extractText(body, mimeType, fileName);
  record.textStatus = extracted.status;
  record.textChars = extracted.text.length;
  if (extracted.error) record.textError = extracted.error;

  if (extracted.status === "DONE" && extracted.text) {
    record.textS3Key = await storeDocumentText(object.key, extracted.text);
    // Only a capped copy goes into MongoDB; the full text stays in S3 so an
    // application-facing document can never grow without bound (§14).
    record.text = extracted.text.slice(0, ingestionEnv.documents.maxTextCharsInMongo);
  }

  return record;
}

function guessMimeType(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const types: Record<string, string> = {
    pdf: "application/pdf",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    csv: "text/csv",
    xml: "application/xml",
    html: "text/html",
    htm: "text/html",
    zip: "application/zip",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    dwg: "image/vnd.dwg",
  };
  return types[extension] ?? "application/octet-stream";
}

/* -------------------------------------------------------------------------- */
/* Claiming                                                                   */
/* -------------------------------------------------------------------------- */

async function claimNext(host?: string): Promise<TenderDocumentRecord | null> {
  const store = await documentStore();
  const now = new Date();

  return store.findOneAndUpdate(
    {
      status: "PENDING",
      nextAttemptAt: { $lte: now },
      ...(host ? { host } : {}),
    },
    {
      $set: {
        status: "RESOLVING",
        leaseOwner: ingestionEnv.workerId,
        heartbeatAt: now,
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
    { returnDocument: "after", sort: { nextAttemptAt: 1 } },
  );
}

async function touchLease(id: string): Promise<void> {
  const store = await documentStore();
  await store.updateOne(
    { _id: id, status: "RESOLVING" },
    { $set: { heartbeatAt: new Date() } },
  );
}

/**
 * Returns rows whose worker died. Selected by heartbeat age, not by worker id, since
 * a restarted process has a new id and could never match its own abandoned rows.
 */
export async function releaseStaleLeases(): Promise<number> {
  const store = await documentStore();
  const cutoff = new Date(Date.now() - ingestionEnv.documents.leaseTtlMs);
  const result = await store.updateMany(
    {
      status: "RESOLVING",
      $or: [{ heartbeatAt: { $lt: cutoff } }, { heartbeatAt: null }],
    },
    {
      $set: {
        status: "PENDING",
        leaseOwner: null,
        heartbeatAt: null,
        nextAttemptAt: new Date(),
      },
    },
  );
  if (result.modifiedCount) {
    log.warn("released stale document leases", { count: result.modifiedCount });
  }
  return result.modifiedCount;
}

async function markSkipped(
  row: TenderDocumentRecord,
  reason: DocumentSkipReason,
  platform: string,
  detail?: string,
  failedFiles: FailedDocumentFile[] = [],
): Promise<void> {
  const store = await documentStore();
  await store.updateOne(
    { _id: row._id },
    {
      $set: {
        status: "SKIPPED",
        skipReason: reason,
        platform,
        failedFiles,
        error: detail ?? null,
        leaseOwner: null,
        heartbeatAt: null,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
  log.debug("document skipped", { host: row.host, reason, url: row.sourceUrl });
}

async function recordFailure(
  row: TenderDocumentRecord,
  error: unknown,
  counters: DocumentRunCounters,
): Promise<void> {
  const store = await documentStore();
  const described = describeError(error);
  const retryable = error instanceof IngestionError ? error.retryable : true;
  const exhausted = row.attempts >= ingestionEnv.documents.maxAttempts;

  if (!retryable || exhausted) {
    counters.failed += 1;
    await store.updateOne(
      { _id: row._id },
      {
        $set: {
          status: "FAILED",
          error: `${described.name}: ${described.message}`.slice(0, 1_000),
          leaseOwner: null,
          heartbeatAt: null,
          updatedAt: new Date(),
        },
      },
    );

    // Also dead-lettered, so document failures are auditable and replayable through
    // the same surface as notice failures rather than needing a separate procedure.
    await recordDeadLetter({
      job: {
        kind: "notice",
        source: row.source,
        mode: "backfill",
        jobKey: `document:${row._id}`,
        notice: {
          source: row.source,
          sourceNoticeId: row.sourceNoticeId,
          sourceVersionId: null,
          versionKey: null,
          publicationNumber: null,
          procedureId: null,
          url: row.sourceUrl,
          publishedAt: null,
          updatedAtSource: null,
          fetchHint: { host: row.host, platform: row.platform ?? "unknown" },
        },
        runId: null,
        attempt: row.attempts,
      },
      error,
      attempts: row.attempts,
      parserVersion: `documents/${row.platform ?? "unknown"}`,
    }).catch((dlqError) =>
      log.error("failed to dead-letter a document row", describeError(dlqError)),
    );

    log.error("document permanently failed", {
      url: row.sourceUrl,
      attempts: row.attempts,
      ...described,
    });
    return;
  }

  const delayMs =
    error instanceof IngestionError
      ? parseRetryAfterFallback(error, row.attempts)
      : exponentialBackoffMs(row.attempts, 30_000);

  await store.updateOne(
    { _id: row._id },
    {
      $set: {
        status: "PENDING",
        error: `${described.name}: ${described.message}`.slice(0, 1_000),
        leaseOwner: null,
        heartbeatAt: null,
        nextAttemptAt: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      },
    },
  );
  log.warn("document retry scheduled", {
    url: row.sourceUrl,
    attempts: row.attempts,
    delayMs,
  });
}
