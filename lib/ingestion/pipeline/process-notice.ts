import { getCollections } from "../db/collections.ts";
import { IngestionError } from "../http/errors.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import { createAdapter } from "../sources/registry.ts";
import { loadRawPayload, storeRawPayload } from "../storage/raw-payload-store.ts";
import type {
  DiscoveredNotice,
  NoticeJob,
  ProcessingOutcome,
  RawNotice,
  SourceConfigDocument,
} from "../types.ts";
import { writeNotice } from "./writer.ts";

const log = logger.child("pipeline");

export interface ProcessResult {
  outcome: ProcessingOutcome;
  canonicalKey: string | null;
  status: string | null;
  /** Source publication to visible-in-app latency, for the section 15.1 SLO. */
  sourceToVisibleMs: number | null;
}

/**
 * Processes one notice job end to end (architecture section 10, steps 9-12).
 *
 * Ordering matters and is load-bearing:
 *   fetch -> hash -> stop early if unchanged -> parse -> store raw -> commit.
 * The raw payload is uploaded and verified before the transaction because S3, like
 * GridFS, cannot participate in one; a crash between the two leaves an orphan that
 * the sweeper removes, never a notice referencing bytes that do not exist.
 */
export async function processNoticeJob(
  job: NoticeJob,
  config: SourceConfigDocument,
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const adapter = createAdapter(config);
  const ref = reviveNotice(job.notice);

  const raw = job.stagedPayload
    ? await loadStagedPayload(job, ref)
    : await adapter.fetch(ref);

  metrics.increment("ingestion_notices_fetched_total", {
    source: job.source,
    mode: job.mode,
    origin: job.stagedPayload ? "staged" : "source",
  });

  // The content hash is the version discriminator when a source supplies no
  // version, so an unchanged republication costs no parse and no write (§8.1).
  const versionKey = ref.versionKey ?? raw.sha256;
  const unchanged = await isUnchanged(job, versionKey, raw.sha256);
  if (unchanged) {
    metrics.increment("ingestion_notices_unchanged_total", {
      source: job.source,
      mode: job.mode,
    });
    return {
      outcome: "UNCHANGED",
      canonicalKey: null,
      status: null,
      sourceToVisibleMs: null,
    };
  }

  const notice = await adapter.parse(raw, { ...ref, versionKey });

  if (notice.processing.validationStatus === "QUARANTINED") {
    throw new IngestionError(
      `${job.source} notice ${notice.source.noticeId} failed validation: ${notice.processing.warnings.join(", ")}`,
      "MALFORMED_PAYLOAD",
      { retryable: false },
    );
  }

  const stored = await storeRawPayload(raw, versionKey);

  const result = await writeNotice({
    notice,
    raw: stored.ref,
    discoveredAt: ref.publishedAt ?? new Date(startedAt),
    fetchedAt: raw.fetchedAt,
    mode: job.mode,
  });

  const publishedAt = notice.publication.publishedAt?.getTime() ?? null;
  const sourceToVisibleMs = publishedAt ? Date.now() - publishedAt : null;

  if (sourceToVisibleMs !== null && job.mode === "live") {
    metrics.observe("ingestion_source_to_visible_ms", sourceToVisibleMs, {
      source: job.source,
    });
  }
  metrics.observe("ingestion_notice_processing_ms", Date.now() - startedAt, {
    source: job.source,
    mode: job.mode,
    outcome: result.outcome,
  });

  log.debug("notice processed", {
    jobKey: job.jobKey,
    outcome: result.outcome,
    canonicalKey: result.canonicalKey,
    status: result.status,
  });

  return {
    outcome: result.outcome,
    canonicalKey: result.canonicalKey,
    status: result.status,
    sourceToVisibleMs,
  };
}

/**
 * Checks the unique source/version identity before parsing. This is the cheap
 * guard that makes an overlap window and a redelivery nearly free.
 */
async function isUnchanged(
  job: NoticeJob,
  versionKey: string,
  contentSha256: string,
): Promise<boolean> {
  const collections = await getCollections();
  const existing = await collections.tenderNotices.findOne(
    {
      "source.code": job.source,
      "source.noticeId": job.notice.sourceNoticeId,
      "source.versionKey": versionKey,
    },
    { projection: { "identity.contentSha256": 1 } },
  );
  return existing?.identity?.contentSha256 === contentSha256;
}

/**
 * Reads a payload that discovery staged to object storage. The checksum is
 * re-verified on read, so a truncated or replaced object fails loudly instead of
 * being parsed into a wrong tender.
 */
async function loadStagedPayload(
  job: NoticeJob,
  ref: DiscoveredNotice,
): Promise<RawNotice> {
  const staged = job.stagedPayload!;
  const body = await loadRawPayload(staged);

  return {
    source: job.source,
    sourceNoticeId: ref.sourceNoticeId,
    body,
    mimeType: staged.mimeType,
    sha256: staged.sha256,
    byteLength: body.byteLength,
    fetchedAt: new Date(),
    url: ref.url,
    licence: job.notice.fetchHint?.licence ?? "",
  };
}

/**
 * Restores a discovered notice after the JSON round trip through Redis. The
 * queue codec already rebuilds the payload Buffer; dates still arrive as strings.
 */
function reviveNotice(notice: DiscoveredNotice): DiscoveredNotice {
  return {
    ...notice,
    publishedAt: toDate(notice.publishedAt),
    updatedAtSource: toDate(notice.updatedAtSource),
  };
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
