import { ObjectId, type ClientSession } from "mongodb";

import { getIngestionClient } from "../db/client.ts";
import { getCollections } from "../db/collections.ts";
import { upsertDocumentRecords } from "../documents/records.ts";
import { classifyMongoError, isDuplicateKeyError } from "../http/errors.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import { commitRawPayload } from "../storage/raw-payload-store.ts";
import type {
  IngestionMode,
  ProcessingOutcome,
  RawPayloadRef,
  SourceNotice,
  TenderNoticeDocument,
} from "../types.ts";
import { sleep } from "../utils/time.ts";
import {
  computeCanonicalKey,
  projectTender,
  shouldSuppressNotifications,
} from "./projection.ts";

const log = logger.child("writer");

const MAX_TRANSACTION_ATTEMPTS = 5;

export interface WriteNoticeInput {
  notice: SourceNotice;
  raw: RawPayloadRef;
  discoveredAt: Date;
  fetchedAt: Date;
  mode: IngestionMode;
}

export interface WriteNoticeResult {
  outcome: ProcessingOutcome;
  noticeId: ObjectId | null;
  tenderId: ObjectId | null;
  canonicalKey: string | null;
  status: string | null;
}

/**
 * The single owner of tender writes (architecture sections 5.1, 6 and 8.1).
 *
 * One short transaction performs the immutable notice upsert, the current tender
 * projection, and the outbox insert, so a notification can never announce a
 * tender that was not committed. No network or API work happens inside the
 * transaction; the raw payload is already uploaded and verified by this point.
 */
export async function writeNotice(input: WriteNoticeInput): Promise<WriteNoticeResult> {
  const { notice, raw } = input;
  const collections = await getCollections();
  const idempotencyKey = buildIdempotencyKey(notice);

  // Fast path outside any transaction: an unchanged source version is by far the
  // most common outcome when an overlap window redelivers the same notice.
  const existingNotice = await collections.tenderNotices.findOne(
    {
      "source.code": notice.source.code,
      "source.noticeId": notice.source.noticeId,
      "source.versionKey": notice.source.versionKey,
    },
    { projection: { _id: 1, "identity.contentSha256": 1 } },
  );

  if (existingNotice && existingNotice.identity?.contentSha256 === raw.sha256) {
    metrics.increment("ingestion_notices_unchanged_total", {
      source: notice.source.code,
      mode: input.mode,
    });
    return {
      outcome: "UNCHANGED",
      noticeId: existingNotice._id,
      tenderId: null,
      canonicalKey: null,
      status: null,
    };
  }

  const client = await getIngestionClient();

  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    const session = client.startSession();
    try {
      const result = await runTransaction(session, input, idempotencyKey);
      // The raw upload is only marked committed once the transaction succeeded,
      // which is what lets the sweeper delete genuine orphans (§6.9).
      await commitRawPayload(raw);
      return result;
    } catch (error) {
      const classified = classifyMongoError(error);
      const contended = isDuplicateKeyError(error) || classified.retryable;

      if (contended && attempt < MAX_TRANSACTION_ATTEMPTS) {
        metrics.increment("ingestion_write_conflicts_total", {
          source: notice.source.code,
        });
        log.debug("retrying contended transaction", {
          attempt,
          source: notice.source.code,
          noticeId: notice.source.noticeId,
        });
        await sleep(25 * attempt + Math.random() * 50);
        continue;
      }
      throw classified;
    } finally {
      await session.endSession();
    }
  }

  throw classifyMongoError(
    new Error(
      `Exhausted ${MAX_TRANSACTION_ATTEMPTS} transaction attempts for ${idempotencyKey}`,
    ),
  );
}

async function runTransaction(
  session: ClientSession,
  input: WriteNoticeInput,
  idempotencyKey: string,
): Promise<WriteNoticeResult> {
  const { notice, raw, mode } = input;
  const collections = await getCollections();
  const now = new Date();
  const isBackfill = mode === "backfill";

  let result: WriteNoticeResult = {
    outcome: "UNCHANGED",
    noticeId: null,
    tenderId: null,
    canonicalKey: null,
    status: null,
  };

  await session.withTransaction(
    async () => {
      const noticeId = new ObjectId();

      const noticeDocument: Omit<TenderNoticeDocument, "_id"> = {
        source: notice.source,
        identity: { idempotencyKey, contentSha256: raw.sha256 },
        publication: {
          publishedAt: notice.publication.publishedAt,
          updatedAtSource: notice.publication.updatedAtSource,
          discoveredAt: input.discoveredAt,
          fetchedAt: input.fetchedAt,
          languages: notice.publication.languages,
        },
        notice: notice.notice,
        snapshot: notice.snapshot,
        raw,
        processing: notice.processing,
        createdAt: now,
      };

      // `$setOnInsert` against the unique source/version index is what makes the
      // pipeline idempotent under concurrent delivery: the second writer sees
      // upsertedId === null and never creates a second version (§8.1).
      const upsert = await collections.tenderNotices.updateOne(
        {
          "source.code": notice.source.code,
          "source.noticeId": notice.source.noticeId,
          "source.versionKey": notice.source.versionKey,
        },
        { $setOnInsert: { _id: noticeId, ...noticeDocument } },
        { upsert: true, session },
      );

      const inserted = upsert.upsertedId !== null && upsert.upsertedId !== undefined;
      const effectiveNoticeId = inserted
        ? noticeId
        : ((
            await collections.tenderNotices.findOne(
              {
                "source.code": notice.source.code,
                "source.noticeId": notice.source.noticeId,
                "source.versionKey": notice.source.versionKey,
              },
              { projection: { _id: 1 }, session },
            )
          )?._id ?? noticeId);

      const projection = projectTender({
        notice,
        noticeId: effectiveNoticeId,
        existing: await collections.tenders.findOne(
          { canonicalKey: computeCanonicalKey(notice) },
          { session },
        ),
        now,
        isBackfill,
      });

      const tenderId = await upsertTender(session, projection, now);

      // Optimistic concurrency: the unique aggregateId+aggregateVersion+eventType
      // index rejects a second writer that computed the same version, and the
      // caller retries the whole transaction.
      await collections.outboxEvents.insertOne(
        {
          _id: new ObjectId(),
          eventType: projection.eventType,
          aggregateId: tenderId,
          aggregateVersion: projection.document.aggregateVersion,
          payload: {
            canonicalKey: projection.canonicalKey,
            status: projection.document.status,
            businessCategory: projection.document.businessCategory,
            cpvCodes: projection.document.cpvCodes,
            countries: projection.document.countries,
            regions: projection.document.regions,
            submissionDeadline: projection.document.submissionDeadline,
            publicationDate: projection.document.publicationDate,
            sources: [...new Set(projection.document.noticeRefs.map((ref) => ref.source))],
            suppressNotifications: shouldSuppressNotifications(projection, isBackfill),
          },
          createdAt: now,
          deliveredAt: null,
          attempts: 0,
          nextAttemptAt: now,
          lastError: null,
        },
        { session },
      );

      // Document work is recorded in the same transaction, so a committed tender can
      // never exist without its document rows queued. Fetching happens later, off the
      // critical path, where a portal being down cannot delay the tender.
      await upsertDocumentRecords(session, {
        tenderId,
        canonicalKey: projection.canonicalKey,
        source: notice.source.code,
        sourceNoticeId: notice.source.noticeId,
        documents: projection.document.documents,
        status: projection.document.status,
        isVisible: projection.document.isVisible,
        now,
      });

      result = {
        outcome: inserted ? "INSERTED" : "UPDATED",
        noticeId: effectiveNoticeId,
        tenderId,
        canonicalKey: projection.canonicalKey,
        status: projection.document.status,
      };
    },
    {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
      readPreference: "primary",
    },
  );

  metrics.increment("ingestion_notices_written_total", {
    source: notice.source.code,
    mode,
    outcome: result.outcome,
  });
  return result;
}

/**
 * Writes the projection with an optimistic-concurrency guard on
 * `aggregateVersion`. A mismatch aborts the transaction so the caller replays it
 * against the newer state instead of silently losing the other writer's update.
 */
async function upsertTender(
  session: ClientSession,
  projection: ReturnType<typeof projectTender>,
  now: Date,
): Promise<ObjectId> {
  const collections = await getCollections();
  const expectedVersion = projection.document.aggregateVersion - 1;

  if (expectedVersion === 0) {
    const tenderId = new ObjectId();
    // A duplicate-key error here means another writer created the aggregate
    // between the read and the insert; `writeNotice` retries the transaction.
    await collections.tenders.insertOne(
      { _id: tenderId, ...projection.document },
      { session },
    );
    return tenderId;
  }

  const updated = await collections.tenders.findOneAndUpdate(
    { canonicalKey: projection.canonicalKey, aggregateVersion: expectedVersion },
    { $set: { ...projection.document, updatedAt: now } },
    { session, returnDocument: "after", projection: { _id: 1 } },
  );

  if (!updated) {
    throw Object.assign(
      new Error(
        `Concurrent update on ${projection.canonicalKey}; expected aggregateVersion ${expectedVersion}`,
      ),
      { errorLabels: ["TransientTransactionError"] },
    );
  }
  return updated._id;
}

/** Durable identity from section 8.1: source + notice id + version key. */
export function buildIdempotencyKey(notice: SourceNotice): string {
  return `${notice.source.code}:${notice.source.noticeId}:${notice.source.versionKey}`;
}
