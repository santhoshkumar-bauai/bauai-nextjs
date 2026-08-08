import { getIngestionDb } from "../../ingestion/db/client.ts";
import { aiCollectionNames, getAiCollections } from "./collections.ts";

/**
 * Plain (non-search) indexes for the AI subsystem. Search and vector indexes
 * live in `search-indexes.ts` because they are created through a different API
 * and are only available on Atlas / atlas-local deployments.
 */
export async function ensureAiIndexes(): Promise<void> {
  const db = await getIngestionDb();
  const existing = new Set(
    (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name),
  );

  for (const name of Object.values(aiCollectionNames)) {
    if (!existing.has(name)) await db.createCollection(name);
  }

  const c = await getAiCollections();

  await c.tenderSearchDocuments.createIndexes([
    { key: { tenderId: 1 }, name: "uq_tender", unique: true },
    { key: { indexedAt: -1 }, name: "ix_indexed_at" },
    // Finds stale vectors after a model or version bump.
    { key: { embeddingModel: 1, embeddingVersion: 1 }, name: "ix_embedding_identity" },
  ]);

  await c.chunks.createIndexes([
    {
      key: { tenderId: 1, documentRecordId: 1, chunkIndex: 1 },
      name: "ix_tender_doc_chunk",
    },
    // Re-chunk cleanup: delete+insert by file identity and chunker version.
    { key: { fileSha256: 1, chunkerVersion: 1 }, name: "ix_file_chunker" },
    { key: { tenantId: 1 }, name: "ix_tenant", sparse: true },
  ]);

  await c.aiIndexState.createIndexes([
    { key: { kind: 1, status: 1, updatedAt: 1 }, name: "ix_kind_status" },
    { key: { refId: 1 }, name: "ix_ref" },
  ]);

  await c.documentClassifications.createIndexes([
    { key: { tenderId: 1 }, name: "ix_tender" },
    { key: { docClass: 1 }, name: "ix_doc_class" },
  ]);

  await c.extractions.createIndexes([
    { key: { tenderId: 1, schemaName: 1 }, name: "uq_tender_schema", unique: true },
    { key: { schemaName: 1, status: 1 }, name: "ix_schema_status" },
  ]);

  await c.tenderFitRecommendations.createIndexes([
    { key: { tenantId: 1, tenderId: 1 }, name: "uq_tenant_tender", unique: true },
  ]);

  await c.tenderOverviews.createIndexes([
    { key: { tenderId: 1 }, name: "uq_tender", unique: true },
  ]);

  // Thread-kind migration, strictly ordered: backfill legacy docs first (the
  // partial index below only covers kind:"tender", which pre-migration docs
  // lack), then swap the old full unique index for the partial one. Both
  // steps are idempotent — safe to run on every boot.
  await c.chatThreads.updateMany({ kind: { $exists: false } }, [
    {
      $set: {
        kind: "tender",
        ownerUserId: null,
        title: null,
        threadKey: {
          $concat: ["dora:", { $toString: "$tenantId" }, ":", { $toString: "$tenderId" }],
        },
      },
    },
  ]);
  try {
    await c.chatThreads.dropIndex("uq_tenant_tender_agent");
  } catch {
    // already dropped (or never created on a fresh database)
  }
  await c.chatThreads.createIndexes([
    {
      // Uniqueness only for tender threads; global threads (tenderId null,
      // many per user) would collide on a full unique index.
      key: { tenantId: 1, tenderId: 1, agent: 1 },
      name: "uq_tender_thread",
      unique: true,
      partialFilterExpression: { kind: "tender" },
    },
    { key: { tenantId: 1, ownerUserId: 1, kind: 1, lastMessageAt: -1 }, name: "ix_owner_recent" },
    { key: { threadKey: 1 }, name: "ix_thread_key", unique: true },
  ]);

  await c.chatMessages.createIndexes([
    { key: { tenantId: 1, threadId: 1, createdAt: 1 }, name: "ix_thread_time" },
  ]);

  // Uploaded-but-never-sent attachments expire after a day; claimed ones are
  // kept (their metadata lives on the message, the text stays queryable).
  await c.chatAttachments.createIndexes([
    {
      key: { createdAt: 1 },
      name: "ttl_unclaimed",
      expireAfterSeconds: 24 * 60 * 60,
      partialFilterExpression: { claimed: false },
    },
  ]);

  await c.tenderVerdicts.createIndexes([
    { key: { tenantId: 1, tenderId: 1 }, name: "uq_tenant_tender", unique: true },
  ]);

  // AI-owned index on the shared `tenders` collection: drives the embedding
  // sweep without scanning 44k documents. Deliberately created here rather
  // than in lib/ingestion/db/indexes.ts — the ingestion pipeline never reads it.
  await db
    .collection("tenders")
    .createIndex(
      { "enrichment.embedding.status": 1, lastSeenAt: -1 },
      { name: "ix_ai_embedding_sweep" },
    );

  // LangGraph checkpoint collections are created implicitly by MongoDBSaver
  // and read/deleted by thread_id (thread reset) — index them here since the
  // saver never does.
  for (const name of ["agent_checkpoints", "agent_checkpoint_writes"]) {
    await db.collection(name).createIndex({ thread_id: 1 }, { name: "ix_thread" });
  }
}
