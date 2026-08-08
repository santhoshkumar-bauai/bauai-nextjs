import type { ClientSession, ObjectId } from "mongodb";

import { ingestionEnv } from "../config/env.ts";
import { getIngestionDb } from "../db/client.ts";
import type { CanonicalDocument, TenderSourceCode, TenderStatus } from "../types.ts";
import { shortHash } from "../utils/hash.ts";
import type {
  DocumentSkipReason,
  DocumentStatus,
  StoredDocumentFile,
  TenderDocumentRecord,
} from "./types.ts";

export const tenderDocumentsCollection = "tender_documents";

export async function documentStore() {
  const db = await getIngestionDb();
  return db.collection<TenderDocumentRecord>(tenderDocumentsCollection);
}

export async function ensureDocumentIndexes(): Promise<void> {
  const store = await documentStore();
  await store.createIndexes([
    { key: { status: 1, nextAttemptAt: 1 }, name: "ix_claimable" },
    // Supports the newest-first claim (status filter + createdAt desc sort).
    { key: { status: 1, createdAt: -1 }, name: "ix_claim_newest" },
    { key: { status: 1, heartbeatAt: 1 }, name: "ix_stale_lease" },
    { key: { tenderId: 1 }, name: "ix_tender" },
    { key: { canonicalKey: 1 }, name: "ix_canonical_key" },
    { key: { host: 1, status: 1 }, name: "ix_host_status" },
    { key: { "files.sha256": 1 }, name: "ix_file_hash", sparse: true },
  ]);
}

/**
 * Deterministic id from the tender and the URL, so the same document reference
 * upserts to one row no matter how many notice versions mention it.
 */
export function documentId(canonicalKey: string, sourceUrl: string): string {
  return `${canonicalKey}#${shortHash(sourceUrl, 20)}`;
}

/** Statuses worth spending bandwidth on, per the biddable-only default. */
const BIDDABLE_STATUSES: TenderStatus[] = ["OPEN", "CLOSING_SOON", "UPCOMING"];

export function shouldFetchForStatus(status: TenderStatus, isVisible: boolean): boolean {
  if (!ingestionEnv.documents.biddableOnly) return true;
  return isVisible && BIDDABLE_STATUSES.includes(status);
}

/**
 * Records the document work for a tender. Called from inside the writer's
 * transaction, so a committed tender always has its document rows — there is no
 * window where a tender exists but its documents were never queued.
 *
 * `$setOnInsert` keeps status and progress: a later notice version re-declaring the
 * same URL must not reset a document that was already fetched.
 */
export async function upsertDocumentRecords(
  /** Null when called outside a transaction, as the row backfill is. */
  session: ClientSession | null,
  input: {
    tenderId: ObjectId;
    canonicalKey: string;
    source: TenderSourceCode;
    sourceNoticeId: string;
    documents: CanonicalDocument[];
    status: TenderStatus;
    isVisible: boolean;
    now: Date;
  },
): Promise<number> {
  if (!ingestionEnv.documents.enabled || !input.documents.length) return 0;

  const store = await documentStore();
  const eligible = shouldFetchForStatus(input.status, input.isVisible);

  const operations = input.documents.flatMap((document) => {
    let host: string;
    try {
      host = new URL(document.url).host;
    } catch {
      // A malformed URL cannot be fetched and cannot be usefully recorded.
      return [];
    }

    // The source's own restriction flag is honoured; those documents are never
    // fetched even when everything else would allow it (§16).
    const initialStatus: DocumentStatus =
      document.restricted || !eligible ? "SKIPPED" : "PENDING";
    const skipReason: DocumentSkipReason | null = document.restricted
      ? "RESTRICTED"
      : eligible
        ? null
        : "TENDER_NOT_BIDDABLE";

    return [
      {
        updateOne: {
          filter: { _id: documentId(input.canonicalKey, document.url) },
          update: {
            $setOnInsert: {
              tenderId: input.tenderId,
              canonicalKey: input.canonicalKey,
              source: input.source,
              sourceNoticeId: input.sourceNoticeId,
              sourceUrl: document.url,
              host,
              platform: null,
              restricted: document.restricted,
              status: initialStatus,
              skipReason,
              files: [] as StoredDocumentFile[],
              attempts: 0,
              leaseOwner: null,
              heartbeatAt: null,
              nextAttemptAt: input.now,
              error: null,
              resolvedAt: null,
              createdAt: input.now,
              updatedAt: input.now,
            },
          },
          upsert: true,
        },
      },
    ];
  });

  if (!operations.length) return 0;
  const result = await store.bulkWrite(operations, {
    ...(session ? { session } : {}),
    ordered: false,
  });
  return result.upsertedCount;
}

/**
 * Creates document rows for tenders that already exist without them.
 *
 * Needed because the writer only records rows for notices it actually writes: an
 * `UNCHANGED` notice short-circuits before the transaction, so re-ingesting cannot
 * retrofit rows onto tenders committed before this feature existed, or while the
 * feature was disabled.
 */
export async function backfillDocumentRows(
  limit = 5_000,
): Promise<{ scanned: number; created: number }> {
  const db = await getIngestionDb();
  const store = await documentStore();

  const tenders = await db
    .collection("tenders")
    .find(
      { "documents.0": { $exists: true } },
      {
        projection: {
          _id: 1,
          canonicalKey: 1,
          documents: 1,
          status: 1,
          isVisible: 1,
          noticeRefs: 1,
        },
        sort: { updatedAt: -1 },
        limit,
      },
    )
    .toArray();

  if (!tenders.length) return { scanned: 0, created: 0 };

  // One query for every candidate id, rather than one per tender.
  const candidateIds = tenders.flatMap((tender) =>
    (tender.documents as CanonicalDocument[]).map((document) =>
      documentId(tender.canonicalKey as string, document.url),
    ),
  );
  const existing = new Set(
    (
      await store
        .find({ _id: { $in: candidateIds } }, { projection: { _id: 1 } })
        .toArray()
    ).map((row) => row._id),
  );

  const now = new Date();
  let created = 0;

  for (const tender of tenders) {
    const documents = (tender.documents as CanonicalDocument[]).filter(
      (document) =>
        !existing.has(documentId(tender.canonicalKey as string, document.url)),
    );
    if (!documents.length) continue;

    const refs = (tender.noticeRefs ?? []) as Array<{
      source: TenderSourceCode;
      sourceNoticeId: string;
    }>;

    created += await upsertDocumentRecords(null, {
      tenderId: tender._id as ObjectId,
      canonicalKey: tender.canonicalKey as string,
      source: refs.at(-1)?.source ?? "DE_BUND",
      sourceNoticeId: refs.at(-1)?.sourceNoticeId ?? "",
      documents,
      status: tender.status as TenderStatus,
      isVisible: Boolean(tender.isVisible),
      now,
    });
  }

  return { scanned: tenders.length, created };
}

/**
 * Promotes documents that were skipped only because their tender was not biddable
 * when first seen. A tender moving UPCOMING → OPEN should make its documents
 * fetchable without a re-ingest.
 */
export async function requeueNowBiddable(limit = 1_000): Promise<number> {
  if (!ingestionEnv.documents.biddableOnly) return 0;

  const db = await getIngestionDb();
  const store = await documentStore();

  const candidates = await store
    .find({ status: "SKIPPED", skipReason: "TENDER_NOT_BIDDABLE" })
    .limit(limit)
    .toArray();
  if (!candidates.length) return 0;

  const tenders = await db
    .collection("tenders")
    .find(
      { _id: { $in: candidates.map((row) => row.tenderId) } },
      { projection: { status: 1, isVisible: 1 } },
    )
    .toArray();

  const biddable = new Set(
    tenders
      .filter((tender) =>
        shouldFetchForStatus(tender.status as TenderStatus, Boolean(tender.isVisible)),
      )
      .map((tender) => String(tender._id)),
  );

  const promote = candidates
    .filter((row) => biddable.has(String(row.tenderId)))
    .map((row) => row._id);
  if (!promote.length) return 0;

  const updated = await store.updateMany(
    { _id: { $in: promote } },
    {
      $set: {
        status: "PENDING",
        skipReason: null,
        nextAttemptAt: new Date(),
        updatedAt: new Date(),
      },
    },
  );
  return updated.modifiedCount;
}
