import { ObjectId } from "mongodb";

import { getCollections } from "../db/collections.ts";
import { IngestionError } from "../http/errors.ts";
import { describeError, logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type {
  DeadLetterDocument,
  IngestionJob,
  RawPayloadRef,
  TenderSourceCode,
} from "../types.ts";

const log = logger.child("dead-letter");

export interface DeadLetterInput {
  job: IngestionJob;
  error: unknown;
  attempts: number;
  parserVersion: string;
  rawPayload?: RawPayloadRef | null;
  runId?: string | null;
}

/**
 * Records a permanently failed job. Section 11.1 forbids discarding a failed
 * notice: the raw payload reference is kept so the same bytes can be replayed
 * through a fixed parser without refetching from the source.
 */
export async function recordDeadLetter(input: DeadLetterInput): Promise<ObjectId> {
  const collections = await getCollections();
  const described = describeError(input.error);
  const errorClass =
    input.error instanceof IngestionError ? input.error.failureClass : described.name;

  const { sourceNoticeId, versionKey } = identityOf(input.job);
  const now = new Date();

  const document: DeadLetterDocument = {
    _id: new ObjectId(),
    source: input.job.source as TenderSourceCode,
    mode: input.job.mode,
    jobKey: input.job.jobKey,
    sourceNoticeId,
    versionKey,
    errorClass,
    // Only the message is stored; stack traces can carry credentials from URLs.
    errorMessage: described.message.slice(0, 2_000),
    attempts: input.attempts,
    parserVersion: input.parserVersion,
    rawPayload: input.rawPayload ?? null,
    job: stripPayload(input.job),
    runId: input.runId ?? null,
    replayStatus: "PENDING",
    createdAt: now,
    updatedAt: now,
  };

  await collections.deadLetterEvents.insertOne(document);

  metrics.increment("ingestion_dead_letters_total", {
    source: document.source,
    errorClass,
  });
  log.error("job dead-lettered", {
    jobKey: document.jobKey,
    errorClass,
    attempts: input.attempts,
    message: document.errorMessage,
  });

  return document._id;
}

/**
 * Inline payloads can be megabytes and are already in S3 for anything that got
 * far enough to be stored, so they are dropped from the archived job.
 */
function stripPayload(job: IngestionJob): IngestionJob {
  if (job.kind !== "notice") return job;
  const notice = { ...job.notice };
  delete notice.inlinePayload;
  return { ...job, notice };
}

function identityOf(job: IngestionJob): {
  sourceNoticeId: string | null;
  versionKey: string | null;
} {
  if (job.kind === "notice") {
    return {
      sourceNoticeId: job.notice.sourceNoticeId,
      versionKey: job.notice.versionKey,
    };
  }
  return { sourceNoticeId: null, versionKey: null };
}

export interface DeadLetterQuery {
  id?: string;
  source?: TenderSourceCode;
  from?: Date;
  to?: Date;
  parserVersion?: string;
  errorClass?: string;
  runId?: string;
  limit?: number;
}

/** Replay selectors from section 11.3. */
export async function findReplayableDeadLetters(
  query: DeadLetterQuery,
): Promise<DeadLetterDocument[]> {
  const collections = await getCollections();
  const filter: Record<string, unknown> = { replayStatus: "PENDING" };

  if (query.id) filter._id = new ObjectId(query.id);
  if (query.source) filter.source = query.source;
  if (query.parserVersion) filter.parserVersion = query.parserVersion;
  if (query.errorClass) filter.errorClass = query.errorClass;
  if (query.runId) filter.runId = query.runId;
  if (query.from || query.to) {
    filter.createdAt = {
      ...(query.from ? { $gte: query.from } : {}),
      ...(query.to ? { $lte: query.to } : {}),
    };
  }

  return collections.deadLetterEvents
    .find(filter)
    .sort({ createdAt: 1 })
    .limit(query.limit ?? 500)
    .toArray();
}

export async function markReplayStatus(
  ids: ObjectId[],
  replayStatus: DeadLetterDocument["replayStatus"],
): Promise<void> {
  if (!ids.length) return;
  const collections = await getCollections();
  await collections.deadLetterEvents.updateMany(
    { _id: { $in: ids } },
    { $set: { replayStatus, updatedAt: new Date() } },
  );
}

export async function deadLetterDepth(): Promise<number> {
  const collections = await getCollections();
  const depth = await collections.deadLetterEvents.countDocuments({
    replayStatus: "PENDING",
  });
  metrics.gauge("ingestion_dead_letter_depth", depth);
  return depth;
}
