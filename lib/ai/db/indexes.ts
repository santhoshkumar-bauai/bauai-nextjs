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

  // Superseded by uq_document_thread_generation (multi-chat panel switcher):
  // the old shape rejects a second conversation per document. Best-effort so
  // a fresh database (index never existed) passes through.
  await c.chatThreads.dropIndex("uq_document_thread").catch(() => undefined);

  await c.chatThreads.createIndexes([
    {
      // Uniqueness only for tender threads; global threads (tenderId null,
      // many per user) would collide on a full unique index.
      key: { tenantId: 1, tenderId: 1, agent: 1 },
      name: "uq_tender_thread",
      unique: true,
      partialFilterExpression: { kind: "tender" },
    },
    {
      // One Dora thread per (tenant, workspace document, chat generation) —
      // "new chat" opens generation N+1; legacy threads (no generation field)
      // index as null and stay unique per document. The uniqueness guard is
      // per-generation since the panel chat switcher landed.
      key: { tenantId: 1, documentId: 1, agent: 1, generation: 1 },
      name: "uq_document_thread_generation",
      unique: true,
      partialFilterExpression: { kind: "document" },
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

  await c.tenderReports.createIndexes([
    { key: { tenantId: 1, tenderId: 1 }, name: "uq_tenant_tender", unique: true },
    { key: { tenantId: 1, generatedAt: -1 }, name: "ix_tenant_recent" },
  ]);

  // The unique key is what makes claiming a run safe: two readers pressing
  // Generate at the same moment race on the upsert and exactly one wins.
  await c.tenderReportRuns.createIndexes([
    { key: { tenantId: 1, tenderId: 1 }, name: "uq_tenant_tender", unique: true },
  ]);

  await c.companyMatchProfiles.createIndexes([
    { key: { tenantId: 1 }, name: "uq_tenant", unique: true },
  ]);

  await c.tenderMatchScores.createIndexes([
    { key: { tenantId: 1, tenderId: 1 }, name: "uq_tenant_tender", unique: true },
    // Drives the feed. The `_id` tiebreak keeps offset paging stable when
    // several tenders land on the same score.
    { key: { tenantId: 1, runId: 1, finalScore: -1, _id: 1 }, name: "ix_tenant_run_score" },
    // Sweeping rows left behind by a superseded run.
    { key: { tenantId: 1, runId: 1 }, name: "ix_tenant_run" },
  ]);

  // Same reasoning as tenderReportRuns: the unique key is what makes claiming
  // a run safe. One company, one refresh in flight.
  await c.companyMatchRuns.createIndexes([
    { key: { tenantId: 1 }, name: "uq_tenant", unique: true },
  ]);

  await c.documentBriefs.createIndexes([
    { key: { tenantId: 1, documentId: 1 }, name: "uq_tenant_document", unique: true },
  ]);

  // Unique claim key — one brief generation in flight per document.
  await c.documentBriefRuns.createIndexes([
    { key: { tenantId: 1, documentId: 1 }, name: "uq_tenant_document", unique: true },
  ]);

  // Cache rows are keyed by string _id (wdoc:{documentId}:{sha}); this index
  // serves the per-document pruning and delete-on-document-removal paths.
  await c.workspaceDocumentTexts.createIndexes([
    { key: { documentId: 1 }, name: "ix_document" },
  ]);

  await c.documentFillRuns.createIndexes([
    { key: { tenantId: 1, documentId: 1, createdAt: -1 }, name: "ix_document_recent" },
    { key: { tenantId: 1, status: 1, updatedAt: 1 }, name: "ix_status_heartbeat" },
  ]);

  // Parsed-source cache; the unique key IS the cache identity (ledger
  // convention: bumping GAEB_PARSER_VERSION makes every row a miss).
  await c.gaebDocuments.createIndexes([
    {
      key: { documentId: 1, sourceSha256: 1, parserVersion: 1 },
      name: "uq_document_sha_parser",
      unique: true,
    },
    { key: { tenantId: 1, documentId: 1 }, name: "ix_tenant_document" },
  ]);

  await c.gaebPriceSheets.createIndexes([
    { key: { tenantId: 1, documentId: 1 }, name: "uq_tenant_document", unique: true },
  ]);

  await c.gaebFillItems.createIndexes([
    { key: { runId: 1, itemKey: 1 }, name: "uq_run_item", unique: true },
    { key: { runId: 1, status: 1 }, name: "ix_run_status" },
    { key: { runId: 1, batchIndex: 1 }, name: "ix_run_batch" },
  ]);

  await db.collection("dora_document_snapshots").createIndexes([
    { key: { expiresAt: 1 }, name: "ttl_snapshot", expireAfterSeconds: 0 },
    { key: { tenantId: 1, documentId: 1, createdAt: -1 }, name: "ix_document_recent" },
  ]);

  await db.collection("dora_edit_transactions").createIndexes([
    { key: { tenantId: 1, documentId: 1, createdAt: -1 }, name: "ix_document_recent" },
    { key: { transactionId: 1, state: 1 }, name: "ix_transaction_state" },
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

  // AI-derived CPV codes (scripts/ai-cpv-derive.mts). MUST exist before the
  // relevance recall `$or` gains its derivedCpvCodes branches: `$or` only uses
  // an index union when every branch is indexed, so a missing index here would
  // silently turn the classic feed's recall into a collection scan.
  await db
    .collection("tenders")
    .createIndex({ derivedCpvCodes: 1 }, { name: "ix_derived_cpv" });

  // LangGraph checkpoint collections are created implicitly by MongoDBSaver
  // and read/deleted by thread_id (thread reset) — index them here since the
  // saver never does.
  for (const name of ["agent_checkpoints", "agent_checkpoint_writes"]) {
    await db.collection(name).createIndex({ thread_id: 1 }, { name: "ix_thread" });
  }
}
