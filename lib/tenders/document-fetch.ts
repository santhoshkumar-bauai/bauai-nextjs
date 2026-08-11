import type { ObjectId } from "mongodb";

import { ingestionEnv } from "../ingestion/config/env.ts";
import { getIngestionDb } from "../ingestion/db/client.ts";
import { DocumentHttpClient } from "../ingestion/documents/http.ts";
import {
  documentStore,
  upsertDocumentRecords,
} from "../ingestion/documents/records.ts";
import { runDocumentFetch } from "../ingestion/documents/runner.ts";
import type { DocumentSkipReason } from "../ingestion/documents/types.ts";
import { describeError, logger } from "../ingestion/observability/logger.ts";
import type {
  CanonicalDocument,
  TenderSourceCode,
  TenderStatus,
} from "../ingestion/types.ts";

const log = logger.child("documents.on-demand");

/**
 * On-demand document fetching for a single tender — the "Fetch documents"
 * button in the Documents tab. The background worker drains the whole
 * `tender_documents` queue on its own schedule; this path requeues just one
 * tender's rows and drains them inline, so a user looking at a tender never
 * has to wait for the worker to reach it (or for a worker to be running at
 * all, e.g. on a dev machine).
 *
 * Safe next to a running worker: rows are claimed atomically, so the two can
 * only split the work, never duplicate it.
 */

/** Skips a fresh attempt could plausibly overturn. `RESTRICTED`,
 *  `LOGIN_REQUIRED` and `TOO_LARGE` stay skipped — retrying cannot help. */
const RETRIABLE_SKIPS: DocumentSkipReason[] = [
  "TENDER_NOT_BIDDABLE",
  "NO_FILES_FOUND",
  "UNSUPPORTED_PLATFORM",
];

export interface TenderDocumentFetchSummary {
  /** Document rows (portal sources) known for this tender. */
  total: number;
  queued: number;
  resolving: number;
  fetched: number;
  skipped: number;
  failed: number;
  /**
   * Rows that look in-flight but whose run died — a RESOLVING row with no
   * recent heartbeat, or a PENDING row nothing has claimed. Excluded from
   * `active` so a killed run (dev-server restart, crashed `after()`) cannot
   * pin the UI in a "fetching" state; the next button press restarts them.
   */
  stalled: number;
  /** True while a fetch is actually progressing — keep polling. */
  active: boolean;
}

/**
 * A run is presumed dead after two missed heartbeats (plus scheduling slack).
 * Far shorter than the worker's lease TTL, which is the point: the button
 * must recover in minutes, not sit disabled for the full lease.
 */
function staleAfterMs(): number {
  const heartbeatMs = Math.max(
    30_000,
    Math.floor(ingestionEnv.documents.leaseTtlMs / 4),
  );
  return heartbeatMs * 2 + 30_000;
}

export async function getTenderDocumentFetchSummary(
  tenderId: ObjectId,
): Promise<TenderDocumentFetchSummary> {
  const store = await documentStore();
  const rows = await store
    .find(
      { tenderId },
      { projection: { status: 1, heartbeatAt: 1, nextAttemptAt: 1, updatedAt: 1 } },
    )
    .toArray();

  const now = Date.now();
  const staleMs = staleAfterMs();
  const age = (value: Date | null | undefined) =>
    value ? now - new Date(value).getTime() : Number.POSITIVE_INFINITY;

  const count = (status: string) =>
    rows.filter((row) => row.status === status).length;
  const queued = count("PENDING");
  const resolving = count("RESOLVING");

  const staleResolving = rows.filter(
    (row) => row.status === "RESOLVING" && age(row.heartbeatAt) > staleMs,
  ).length;
  // A live run claims a due PENDING row within seconds and refreshes
  // updatedAt on every retry, so a due row untouched this long has no worker.
  const stalePending = rows.filter(
    (row) =>
      row.status === "PENDING" &&
      Math.min(age(row.updatedAt), age(row.nextAttemptAt)) > staleMs,
  ).length;

  return {
    total: rows.length,
    queued,
    resolving,
    fetched: count("FETCHED"),
    skipped: count("SKIPPED"),
    failed: count("FAILED"),
    stalled: staleResolving + stalePending,
    active: queued - stalePending + (resolving - staleResolving) > 0,
  };
}

/**
 * Makes every retriable row of this tender claimable right now and returns
 * the resulting summary. Also backfills rows for tenders committed while the
 * documents feature was off — same gap `backfillDocumentRows` covers, but for
 * exactly one tender.
 */
export async function prepareTenderDocumentFetch(
  tenderId: ObjectId,
): Promise<TenderDocumentFetchSummary> {
  const db = await getIngestionDb();
  const tender = await db.collection("tenders").findOne(
    { _id: tenderId },
    {
      projection: {
        canonicalKey: 1,
        documents: 1,
        status: 1,
        isVisible: 1,
        noticeRefs: 1,
      },
    },
  );

  const now = new Date();

  if (tender && (tender.documents as CanonicalDocument[] | undefined)?.length) {
    const refs = (tender.noticeRefs ?? []) as Array<{
      source: TenderSourceCode;
      sourceNoticeId: string;
    }>;
    await upsertDocumentRecords(null, {
      tenderId,
      canonicalKey: tender.canonicalKey as string,
      source: refs.at(-1)?.source ?? "DE_BUND",
      sourceNoticeId: refs.at(-1)?.sourceNoticeId ?? "",
      documents: tender.documents as CanonicalDocument[],
      status: tender.status as TenderStatus,
      isVisible: Boolean(tender.isVisible),
      now,
    });
  }

  const store = await documentStore();
  const staleCutoff = new Date(now.getTime() - staleAfterMs());
  await store.updateMany(
    {
      tenderId,
      $or: [
        // PENDING rows too: a retry backoff must not make the button a no-op.
        { status: "PENDING" },
        { status: "FAILED" },
        { status: "SKIPPED", skipReason: { $in: RETRIABLE_SKIPS } },
        // Stranded by a killed run (dev restart, crashed `after()`): the
        // heartbeat proves nobody is working it, so take the lease back now
        // rather than waiting out the worker's full lease TTL.
        {
          status: "RESOLVING",
          $or: [{ heartbeatAt: null }, { heartbeatAt: { $lt: staleCutoff } }],
        },
      ],
    },
    {
      $set: {
        status: "PENDING",
        skipReason: null,
        // A fresh click deserves the full retry budget again.
        attempts: 0,
        nextAttemptAt: now,
        error: null,
        leaseOwner: null,
        heartbeatAt: null,
        updatedAt: now,
      },
    },
  );

  return getTenderDocumentFetchSummary(tenderId);
}

/** Drains this tender's queued rows inline. Runs inside `after()`. */
export async function runTenderDocumentFetch(tenderId: ObjectId): Promise<void> {
  try {
    const counters = await runDocumentFetch({
      limit: null,
      // A tender rarely has more than a handful of sources, and most live on
      // the same rate-limited host — modest parallelism is all it can use.
      concurrency: 2,
      tenderId,
      exitWhenDrained: true,
      // A user is waiting on this fetch, so it gets its own generous per-host
      // budget and downloads files in parallel — a one-tender burst comparable
      // to a bidder's browser, not the crawl-wide politeness rate.
      http: new DocumentHttpClient({
        requestsPerMinutePerHost:
          ingestionEnv.documents.onDemandRequestsPerMinutePerHost,
        maxConcurrentPerHost: ingestionEnv.documents.onDemandConcurrentPerHost,
      }),
      fileConcurrency: ingestionEnv.documents.onDemandConcurrentPerHost,
    });
    log.info("on-demand document fetch finished", {
      tenderId: String(tenderId),
      ...counters,
    });
  } catch (error) {
    log.error("on-demand document fetch crashed", {
      tenderId: String(tenderId),
      ...describeError(error),
    });
  }
}
