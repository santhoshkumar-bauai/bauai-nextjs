import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { StreamQueue } from "../queue/stream-queue.ts";
import { estimateJobBytes } from "../queue/job-codec.ts";
import { createAdapter } from "../sources/registry.ts";
import { storeRawPayload } from "../storage/raw-payload-store.ts";
import type {
  DiscoveredNotice,
  DiscoveryCursor,
  IngestionMode,
  NoticeJob,
  QueueName,
  RawNotice,
  SourceConfigDocument,
} from "../types.ts";
import { sha256 } from "../utils/hash.ts";
import { saveCheckpoint } from "./checkpoints.ts";
import type { RunHandle } from "../pipeline/runs.ts";

const log = logger.child("discovery");

/**
 * Above this size a payload is written to object storage and referenced instead of
 * being carried through Redis. The queue is transport, not a tender database (§5.1).
 */
const INLINE_PAYLOAD_LIMIT_BYTES = 256 * 1024;

export interface DiscoveryOutcome {
  discovered: number;
  accepted: number;
  unchanged: boolean;
  httpStatus: number | null;
}

export interface RunDiscoveryInput {
  config: SourceConfigDocument;
  mode: IngestionMode;
  cursor: DiscoveryCursor;
  queue: StreamQueue;
  targetQueue: QueueName;
  run: RunHandle;
  signal?: AbortSignal;
}

/**
 * One discovery pass (architecture section 10, steps 4-8).
 *
 * The checkpoint is saved only after every notice in a batch has been durably
 * accepted by the queue, so a crash mid-batch replays that batch rather than
 * skipping it. Redelivery is safe because the stable job key deduplicates and the
 * writer is idempotent.
 */
export async function runDiscovery(input: RunDiscoveryInput): Promise<DiscoveryOutcome> {
  const { config, mode, cursor, queue, targetQueue, run } = input;
  const adapter = createAdapter(config);

  let discovered = 0;
  let accepted = 0;
  let unchanged = true;
  let httpStatus: number | null = null;

  for await (const batch of adapter.discover(cursor)) {
    if (input.signal?.aborted) {
      log.warn("discovery aborted by shutdown", { source: config._id, mode });
      break;
    }

    httpStatus = batch.httpStatus;
    if (!batch.unchanged) unchanged = false;
    discovered += batch.notices.length;
    run.counters.discovered += batch.notices.length;

    let acceptedInBatch = 0;
    for (const notice of batch.notices) {
      const job = await buildNoticeJob(notice, adapter.licence, mode, run.id);
      if (await queue.enqueue(targetQueue, job)) acceptedInBatch += 1;
    }

    accepted += acceptedInBatch;

    await saveCheckpoint(config._id, mode, batch.nextCursor);
    await run.heartbeat();

    if (batch.archive) {
      await run.recordArchive({
        checksum: batch.archive.checksum,
        byteLength: batch.archive.byteLength,
        httpStatus: batch.httpStatus,
      });
    }

    // Live polling stops as soon as a page yields nothing new: the overlap window
    // has caught up with what was already queued, and paging further would walk
    // the whole day's publications on every 2-minute poll.
    if (mode === "live" && acceptedInBatch === 0) {
      log.debug("live discovery caught up", {
        source: config._id,
        pageNotices: batch.notices.length,
      });
      break;
    }
  }

  metrics.increment(
    "ingestion_discovered_total",
    { source: config._id, mode },
    discovered,
  );
  log.info("discovery complete", {
    source: config._id,
    mode,
    discovered,
    accepted,
    unchanged,
  });

  return { discovered, accepted, unchanged, httpStatus };
}

/**
 * Builds the queue job, staging the payload to object storage when it is large or
 * when the run is a backfill partition — a monthly export holds tens of thousands
 * of notices and their bytes must not sit in Redis.
 */
async function buildNoticeJob(
  notice: DiscoveredNotice,
  licence: string,
  mode: IngestionMode,
  runId: string,
): Promise<NoticeJob> {
  const versionKey = notice.versionKey ?? sha256(notice.inlinePayload?.body ?? Buffer.alloc(0));
  const base: NoticeJob = {
    kind: "notice",
    source: notice.source,
    mode,
    jobKey: `${notice.source}:${notice.sourceNoticeId}:${versionKey}`,
    notice: { ...notice, versionKey },
    runId,
    attempt: 0,
  };

  const payload = notice.inlinePayload;
  if (!payload) return base;

  const shouldStage =
    mode === "backfill" ||
    payload.body.byteLength > INLINE_PAYLOAD_LIMIT_BYTES ||
    estimateJobBytes(base) > INLINE_PAYLOAD_LIMIT_BYTES * 2;

  if (!shouldStage) return base;

  const raw: RawNotice = {
    source: notice.source,
    sourceNoticeId: notice.sourceNoticeId,
    body: payload.body,
    mimeType: payload.mimeType,
    sha256: sha256(payload.body),
    byteLength: payload.body.byteLength,
    fetchedAt: new Date(),
    url: notice.url,
    licence,
  };

  const stored = await storeRawPayload(raw, versionKey);
  metrics.increment("ingestion_payloads_staged_total", { source: notice.source, mode });

  return {
    ...base,
    // The inline copy is dropped so the queue message stays small; the worker
    // reads the payload back from storage and re-verifies its checksum.
    notice: { ...base.notice, inlinePayload: undefined, fetchHint: { licence } },
    stagedPayload: stored.ref,
  };
}
