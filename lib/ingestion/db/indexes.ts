import { getIngestionDb } from "./client.ts";
import { collectionNames, getCollections } from "./collections.ts";
import { ensureDocumentIndexes } from "../documents/records.ts";
import { logger } from "../observability/logger.ts";

const log = logger.child("db.indexes");

/**
 * Index set from architecture section 12. Every index is created before the
 * first import so the unique constraints — not application logic — are what
 * actually prevent duplicate source versions.
 */
export async function ensureIngestionIndexes(): Promise<void> {
  const db = await getIngestionDb();
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  for (const name of Object.values(collectionNames)) {
    if (!existing.has(name)) await db.createCollection(name);
  }

  const c = await getCollections();

  await c.tenderNotices.createIndexes([
    {
      key: { "source.code": 1, "source.noticeId": 1, "source.versionKey": 1 },
      name: "uq_source_notice_version",
      unique: true,
    },
    { key: { "source.code": 1, "publication.publishedAt": -1 }, name: "ix_source_published" },
    { key: { "source.procedureId": 1 }, name: "ix_procedure" },
    { key: { "identity.contentSha256": 1 }, name: "ix_content_hash" },
    { key: { "source.publicationNumber": 1 }, name: "ix_publication_number", sparse: true },
    { key: { "notice.typeCode": 1, "publication.publishedAt": -1 }, name: "ix_type_published" },
  ]);

  await c.tenders.createIndexes([
    { key: { canonicalKey: 1 }, name: "uq_canonical_key", unique: true },
    {
      key: { status: 1, submissionDeadline: 1, publicationDate: -1 },
      name: "ix_status_deadline",
    },
    { key: { businessCategory: 1, publicationDate: -1 }, name: "ix_category_published" },
    { key: { cpvCodes: 1, status: 1, submissionDeadline: 1 }, name: "ix_cpv_status" },
    // Section 12 lists a single `{ countries, regions, status }` index, but MongoDB
    // cannot index two array fields together: any tender with several countries
    // *and* several regions is rejected with "cannot index parallel arrays"
    // (error 171). The index creates successfully and only fails on insert, so it
    // has to be split. Two indexes serve the same filters — a query on country or
    // region plus status — without that failure mode.
    {
      key: { countries: 1, status: 1, submissionDeadline: 1 },
      name: "ix_country_status",
    },
    { key: { regions: 1, status: 1, submissionDeadline: 1 }, name: "ix_region_status" },
    { key: { "buyer.location": "2dsphere" }, name: "ix_buyer_location_2dsphere" },
    // Drives the 5-minute status updater without scanning the collection.
    { key: { isVisible: 1, status: 1, submissionDeadline: 1 }, name: "ix_status_sweep" },
    { key: { "noticeRefs.sourceNoticeId": 1 }, name: "ix_notice_refs" },
    { key: { "relatedNoticeIds.value": 1 }, name: "ix_related_notices", sparse: true },
  ]);

  await c.ingestionRuns.createIndexes([
    { key: { source: 1, startedAt: -1 }, name: "ix_source_started" },
    { key: { status: 1, heartbeatAt: 1 }, name: "ix_status_heartbeat" },
    { key: { mode: 1, startedAt: -1 }, name: "ix_mode_started" },
  ]);

  await c.outboxEvents.createIndexes([
    {
      key: { aggregateId: 1, aggregateVersion: 1, eventType: 1 },
      name: "uq_aggregate_version_event",
      unique: true,
    },
    { key: { deliveredAt: 1, nextAttemptAt: 1 }, name: "ix_undelivered" },
  ]);

  await c.deadLetterEvents.createIndexes([
    { key: { source: 1, replayStatus: 1, createdAt: -1 }, name: "ix_source_replay" },
    { key: { jobKey: 1 }, name: "ix_job_key" },
    { key: { errorClass: 1, createdAt: -1 }, name: "ix_error_class" },
  ]);

  await c.sourceCheckpoints.createIndexes([
    { key: { source: 1, mode: 1 }, name: "ix_source_mode" },
    { key: { leaseUntil: 1 }, name: "ix_lease_until" },
  ]);

  await ensureDocumentIndexes();

  log.info("ingestion indexes ensured");
}
