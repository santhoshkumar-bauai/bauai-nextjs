import { ObjectId } from "mongodb";

import { ingestionEnv } from "../config/env.ts";
import { getCollections } from "../db/collections.ts";
import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { TenderDocument, TenderStatus } from "../types.ts";
import { deriveStatus } from "./status.ts";

const log = logger.child("status-updater");

/**
 * Moves tenders across deadline boundaries.
 *
 * Section 7 asks for a lightweight sweep every 5 minutes that updates status only
 * and never redownloads a notice. The query is deliberately narrow: only records
 * whose current status could still change with the passage of time are read.
 */
export async function updateExpiredStatuses(now = new Date()): Promise<{
  scanned: number;
  changed: number;
}> {
  const collections = await getCollections();
  const closingSoonAt = new Date(
    now.getTime() + ingestionEnv.status.closingSoonHours * 3_600_000,
  );

  const timeSensitive: TenderStatus[] = ["OPEN", "CLOSING_SOON", "UPCOMING"];

  const candidates = await collections.tenders
    .find(
      {
        status: { $in: timeSensitive },
        submissionDeadline: { $ne: null, $lte: closingSoonAt },
      },
      {
        projection: {
          _id: 1,
          canonicalKey: 1,
          status: 1,
          businessCategory: 1,
          submissionDeadline: 1,
          aggregateVersion: 1,
          cpvCodes: 1,
          countries: 1,
          regions: 1,
          publicationDate: 1,
          noticeRefs: 1,
        },
      },
    )
    .limit(20_000)
    .toArray();

  let changed = 0;

  for (const tender of candidates) {
    const next = deriveStatus({
      businessCategory: tender.businessCategory,
      submissionDeadline: tender.submissionDeadline,
      // A cancelled or awarded tender is not in `timeSensitive`, so neither flag
      // can be reintroduced by this sweep.
      isCancelled: false,
      isAwarded: false,
      now,
    });

    if (next === tender.status) continue;
    if (await applyStatusChange(tender, next, now)) changed += 1;
  }

  metrics.gauge("ingestion_status_sweep_candidates", candidates.length);
  metrics.increment("ingestion_status_changes_total", {}, changed);

  if (changed) log.info("status sweep applied changes", { changed, scanned: candidates.length });
  return { scanned: candidates.length, changed };
}

/**
 * Applies one status change and emits the matching outbox event so the app sees
 * `CLOSING_SOON` and `CLOSED` transitions through the same path as ingestion.
 * The `aggregateVersion` guard keeps it from racing an in-flight ingestion write.
 */
async function applyStatusChange(
  tender: Pick<
    TenderDocument,
    | "_id"
    | "canonicalKey"
    | "status"
    | "businessCategory"
    | "submissionDeadline"
    | "aggregateVersion"
    | "cpvCodes"
    | "countries"
    | "regions"
    | "publicationDate"
    | "noticeRefs"
  >,
  next: TenderStatus,
  now: Date,
): Promise<boolean> {
  const collections = await getCollections();
  const nextVersion = tender.aggregateVersion + 1;

  const updated = await collections.tenders.updateOne(
    { _id: tender._id, aggregateVersion: tender.aggregateVersion },
    { $set: { status: next, aggregateVersion: nextVersion, updatedAt: now } },
  );

  if (!updated.modifiedCount) return false;

  try {
    await collections.outboxEvents.insertOne({
      _id: new ObjectId(),
      eventType: "TENDER_STATUS_CHANGED",
      aggregateId: tender._id,
      aggregateVersion: nextVersion,
      payload: {
        canonicalKey: tender.canonicalKey,
        status: next,
        businessCategory: tender.businessCategory,
        cpvCodes: tender.cpvCodes,
        countries: tender.countries,
        regions: tender.regions,
        submissionDeadline: tender.submissionDeadline,
        publicationDate: tender.publicationDate,
        sources: [...new Set(tender.noticeRefs.map((ref) => ref.source))],
        // A deadline crossing is not new information a user asked to hear about;
        // saved-search alerts are for new and updated opportunities.
        suppressNotifications: true,
      },
      createdAt: now,
      deliveredAt: null,
      attempts: 0,
      nextAttemptAt: now,
      lastError: null,
    });
  } catch (error) {
    // A duplicate event means another replica already recorded this transition.
    if ((error as { code?: number }).code !== 11000) throw error;
  }

  return true;
}
