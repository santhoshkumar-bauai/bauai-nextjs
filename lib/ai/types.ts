import type { ObjectId } from "mongodb";

import type { WireTenderRef } from "./agent/wire.ts";
import type { DocClass } from "./classification/doc-classes.ts";

/**
 * Persistence shapes for the AI subsystem (roadmap §12, adapted).
 *
 * Tenancy rule: tender-derived data is global reference data (§6.3) — one
 * shared embedding corpus for all companies. Company-derived and agent-produced
 * data carries a `tenantId` (the `Company._id`). `chunks.tenantId` is `null`
 * for the shared corpus so tenant-owned chunks can join the same indexes later,
 * and every retrieval query constrains `tenantId ∈ {null, currentTenant}`.
 */

/** Identity stamped onto every stored vector (§17.1). */
export interface EmbeddingMeta {
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;
  /** sha256 of the exact text that was embedded; staleness detector. */
  sourceHash: string;
}

/** Curated searchable representation of one tender notice (§12.2). */
export interface TenderSearchDocument extends EmbeddingMeta {
  _id?: ObjectId;
  tenderId: ObjectId;
  canonicalKey: string;
  language: string | null;

  /** Curated text ("Title: ...\nBuyer: ..."), never raw JSON (§17.2). */
  text: string;

  /** Pre-filters for $vectorSearch; mirrors the tender aggregate. */
  filters: {
    status: string;
    businessCategory: string | null;
    cpvCodes: string[];
    countryCodes: string[];
    regionCodes: string[];
    procedureType: string | null;
    contractNature: string | null;
    estimatedValueAmount: number | null;
    submissionDeadline: Date | null;
  };

  embedding: number[];
  indexedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Positional anchor (§12.4). Page/paragraph/bbox arrive with the Python
 * document worker; char offsets are exact against the extracted flat text. */
export interface ChunkAnchor {
  page: number | null;
  paragraph: number | null;
  bbox: [number, number, number, number] | null;
  charStart: number;
  charEnd: number;
}

/** One retrievable chunk of one tender document file (§12.4) — or, when
 * `tenantId` is set and `tenderId` is null, of a company document. */
export interface ChunkDocument extends EmbeddingMeta {
  _id?: ObjectId;
  /** null = shared tender corpus; ObjectId = tenant-owned (company upload). */
  tenantId: ObjectId | null;
  /** null for company-corpus chunks. */
  tenderId: ObjectId | null;
  /** `tender_documents._id` ("canonicalKey#hash") or "company:{fileId}". */
  documentRecordId: string;
  fileSha256: string;
  fileName: string;
  mimeType: string | null;

  /** Stamped by the classifier after chunking; null until classified. */
  docClass: DocClass | null;
  language: string | null;
  sectionPath: string[];
  chunkIndex: number;

  text: string;
  /** Normalised legal references ("§ 13 VOB/B"), exact-match indexed (§16.2). */
  legalRefs: string[];
  anchor: ChunkAnchor;
  tokenCount: number;
  chunkerVersion: string;

  embedding: number[];
  createdAt: Date;
}

/** Work-ledger statuses shared by AI indexing states. */
export type AiIndexStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED";

/**
 * Per-file classification record (roadmap §15.3/§15.4). Corrections later
 * feed evaluation data, so the method and rule that produced each decision
 * are kept.
 */
export interface DocumentClassificationDocument {
  /** "{documentRecordId}#{fileSha256}" — one classification per file. */
  _id: string;
  tenderId: ObjectId;
  documentRecordId: string;
  fileSha256: string;
  fileName: string;
  docClass: DocClass;
  confidence: number;
  method: "heuristic" | "llm";
  /** Heuristic rule name, or the model id for LLM classifications. */
  source: string;
  classifierVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One extraction record per (tenderId, schemaName) — roadmap §12.5 adapted:
 * merged across the tender's documents, replaced wholesale on re-extraction.
 * `corpusHash` identifies the document corpus the record was computed from;
 * a new fetched document changes it and re-enables extraction.
 */
export interface ExtractionDocument {
  _id?: ObjectId;
  /** Tender-derived shared data — global by convention. */
  tenantId: null;
  tenderId: ObjectId;
  schemaName: string;
  schemaVersion: number;
  model: {
    provider: string;
    providerModel: string;
    promptVersion: string;
    temperature: number;
  };
  corpusHash: string;
  sourceDocumentRecordIds: string[];
  /** Field name → StoredCitedValue (lib/ai/extraction/citations.ts). */
  fields: Record<string, unknown>;
  unresolved: string[];
  status: "VERIFIED" | "PARTIAL" | "EMPTY" | "FAILED";
  stats: {
    modelCalls: number;
    retriedFields: number;
    verifiedFields: number;
    totalFields: number;
  };
  extractedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Clara's bid/no-bid verdict (roadmap §12.6/§20.3). Tenant-scoped — it
 * depends on the company's fit. One current verdict per (tenant, tender),
 * replaced wholesale. `review` follows §12.6; the review UI is future work.
 */
export interface TenderVerdictDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  tenderId: ObjectId;
  threadId: ObjectId | null;
  messageId: ObjectId | null;
  agentRunId: null;
  recommendation: "bid" | "no_bid" | "conditional";
  rationale: string;
  scoreBreakdown: {
    eligibilityFit: number;
    strategicFit: number;
    capacityFit: number;
    contractRisk: number;
    deadlineFeasibility: number;
  };
  /** citations are ChatCitation[] (lib/ai/agent/citations.ts). */
  risks: Array<{
    text: string;
    severity: "low" | "medium" | "high";
    citations: Array<Record<string, unknown>>;
    uncited?: boolean;
  }>;
  blockingRequirements: Array<{
    text: string;
    citations: Array<Record<string, unknown>>;
  }>;
  unresolvedQuestions: string[];
  inputs: {
    corpusHash: string | null;
    companyDataHash: string;
    extractionStatuses: Record<string, string>;
    fitGeneratedAt: Date | null;
  };
  model: { provider: string; providerModel: string; promptVersion: string };
  review: {
    state: "PENDING";
    reviewerId: null;
    reviewedAt: null;
    edits: [];
  };
  locale: "en" | "de";
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An agent chat thread. Three kinds share this collection:
 * - "tender" (Clara): company-shared, exactly one per (tenant, tender) —
 *   enforced by a partial unique index. `tenderId` set, `ownerUserId` null.
 * - "global" (Clara): private per user, many per user. `tenderId` null,
 *   `ownerUserId` set, `title` from the first message (renameable).
 * - "document" (Dora): company-shared, exactly one per (tenant, workspace
 *   document) — partial unique index. `documentId` set, others null.
 * `threadKey` is the LangGraph checkpoint id; the formats
 * (`clara:{tenant}:{tender}`, `dora:{tenant}:{document}`) are frozen —
 * changing one orphans checkpoints.
 */
export interface ChatThreadDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  kind: "tender" | "global" | "document" | "onboarding" | "fill_session";
  tenderId: ObjectId | null;
  /** Workspace document a "document" (Dora) thread is bound to; else null. */
  documentId?: ObjectId | null;
  ownerUserId: string | null;
  threadKey: string;
  title: string | null;
  /** Dora document chats: 0 = the legacy frozen-key thread, 1+ = "new chat"
   * generations. Highest generation is the active conversation. */
  generation?: number;
  agent: "clara" | "dora" | "otto" | "fill_agent";
  createdBy: string;
  graphVersion: string;
  lastMessageAt: Date;
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A file attached to a chat message. Raw bytes go to S3; documents get their
 * text extracted at upload, images are fed to the model as vision input.
 * Unclaimed rows (uploaded but never sent) expire via a TTL index.
 */
export interface ChatAttachmentDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  /** Uploader; claiming a message requires the same user. */
  userId: string;
  fileName: string;
  contentType: string;
  size: number;
  /** Raw bytes in the bucket (chat category under the tenant's prefix). */
  s3Key: string | null;
  /** ready = model-readable (text extracted or vision-capable image). */
  status: "ready" | "unsupported" | "failed";
  /** Extracted text, capped at upload time. Empty for images. */
  text: string;
  claimed: boolean;
  createdAt: Date;
}

/** Attachment metadata carried on a persisted message (for rendering). */
export interface ChatMessageAttachment {
  fileName: string;
  contentType: string;
  size: number;
  status: "ready" | "unsupported" | "failed";
}

/** UI-facing chat log (model context lives in the LangGraph checkpointer). */
export interface ChatMessageDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  threadId: ObjectId;
  /** Null for messages in global (non-tender) threads. */
  tenderId: ObjectId | null;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "aborted" | "error";
  locale: "en" | "de";
  /** Coarse tool activity for rendering — never model reasoning. */
  toolEvents: Array<{ name: string; durationMs: number; resultCount: number | null }>;
  /** ChatCitation[] (lib/ai/agent/citations.ts). */
  citations: Array<Record<string, unknown>>;
  /** Files attached to this (user) message; absent on older documents. */
  attachments?: ChatMessageAttachment[];
  /**
   * Tenders the turn's tools surfaced, rendered as links into the tender's own
   * pages. Absent on messages written before tender cards existed.
   */
  tenderRefs?: WireTenderRef[];
  verdictId: ObjectId | null;
  metrics: {
    llmCalls: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Tender-centric AI overview (about / scope / buyer / risks / highlights),
 * generated in BOTH languages with one call — the UI picks by locale.
 * Tender-derived → global. Works from the notice alone; document excerpts
 * enrich it when they exist (`sourceChunkCount` > 0).
 */
export interface TenderOverviewDocument {
  _id?: ObjectId;
  tenantId: null;
  tenderId: ObjectId;
  /** { en: {about, scope, buyer, risks[], highlights[]}, de: {...} } */
  overview: Record<string, unknown>;
  sourceChunkCount: number;
  /** Chunk-corpus identity used, or null for notice-only generations. */
  corpusHash: string | null;
  model: { provider: string; providerModel: string; promptVersion: string };
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cached company-fit recommendation, tenant-scoped: the assessment depends on
 * the company's own data, so it is private to the tenant and keyed by a
 * `companyDataHash` — when company data changes the stored hash no longer
 * matches and the UI shows the cached result as stale.
 */
export interface TenderFitRecommendationDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  tenderId: ObjectId;
  companyDataHash: string;
  locale: "en" | "de";
  /** TenderRecommendation shape from lib/tenders/recommendation.ts. */
  recommendation: Record<string, unknown>;
  model: { provider: string; providerModel: string; promptVersion: string };
  /** Extraction corpus identity used for the facts section, if any. */
  corpusHash: string | null;
  retrievedChunkIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The full tender report: one long-form, decision-ready dossier synthesized
 * from every other artifact (notice, overview, extractions, fit, verdict,
 * document corpus) plus the company's own profile and documents. Tenant-scoped
 * — it assesses the tender against ONE company — and replaced wholesale on
 * regeneration. Staleness is the same triple as the verdict: document corpus,
 * company data, prompt version.
 */
export interface TenderReportDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  tenderId: ObjectId;
  /** Snapshot of the tender's headline data, so exports need no re-fetch. */
  tender: {
    title: string | null;
    buyerName: string | null;
    submissionDeadline: Date | null;
    estimatedValue: { amount: string | null; currency: string | null } | null;
    procedureType: string | null;
  };
  companyName: string | null;
  /**
   * TenderReportContent per UI language (lib/ai/report/schema.ts). Written
   * once in `primaryLocale` and translated into the other, so the two can
   * never disagree about the verdict. A language is absent only when its
   * translation pass failed.
   */
  report: Partial<Record<"en" | "de", Record<string, unknown>>>;
  /** Evidence id → ChatCitation, resolved server-side after generation. */
  citations: Record<string, Record<string, unknown>>;
  inputs: {
    corpusHash: string | null;
    companyDataHash: string;
    extractionStatuses: Record<string, string>;
    tenderChunkCount: number;
    companyChunkCount: number;
    hasOverview: boolean;
    hasVerdict: boolean;
    hasFit: boolean;
  };
  model: { provider: string; providerModel: string; promptVersion: string };
  /** The language the analysis was reasoned in; the other one is translated. */
  primaryLocale: "en" | "de";
  generatedByUserId: string;
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An in-flight (or just-finished) report generation, one per (tenant, tender).
 *
 * A report takes minutes, so the run cannot live in the request that started
 * it: the reader reloads, closes the tab, or loses the connection, and must
 * still find the work in progress rather than an empty page. This record is
 * the single source of truth for "is something running and how far is it",
 * which is what makes the page resumable and what stops two readers from
 * kicking off the same expensive generation twice.
 *
 * `updatedAt` doubles as a heartbeat: a `running` row that stops being touched
 * belongs to a process that died, and may be claimed again.
 */
export interface TenderReportRunDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  tenderId: ObjectId;
  status: "running" | "done" | "failed";
  /** Which step the run is on; meaningless unless `status` is "running". */
  stage: "gathering" | "analyzing" | "translating" | "saving";
  locale: "en" | "de";
  startedByUserId: string;
  /** i18n key ("rate_limited" | "invalid_output" | "failed"), never raw. */
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Dora's Document Brief: the structured "what is this file and what must you
 * do" analysis of ONE workspace document, grounded in the linked tender's
 * corpus and the company profile. One per (tenant, document), replaced
 * wholesale on regeneration. Stale when `versionSha256` no longer matches the
 * document's current committed version (computed lazily at read time — the
 * ONLYOFFICE callback path is never hooked).
 */
export interface DocumentBriefDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  /** WorkspaceDocument _id. */
  documentId: ObjectId;
  /** The committed version the brief analyzed. */
  versionId: ObjectId;
  versionSha256: string;
  storageRevision: number;
  /**
   * BriefContent per UI language (lib/ai/dora/brief-schema.ts). Written in
   * the requesting user's locale and translated into the other; a language is
   * absent only when its translation pass failed.
   */
  brief: Partial<Record<"en" | "de", Record<string, unknown>>>;
  /** Evidence id → ChatCitation, resolved server-side after generation. */
  citations: Record<string, Record<string, unknown>>;
  /** How the document text was obtained; drives UI limitation notices. */
  textInfo: {
    status: "ready" | "unsupported" | "failed";
    source: "native" | "converted-csv" | "gaeb-projection" | null;
    note: string | null;
    chars: number;
    truncated: boolean;
  };
  model: { provider: string; providerModel: string; promptVersion: string };
  generatedByUserId: string;
  generatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An in-flight (or just-finished) brief generation, one per (tenant,
 * document). Same design as TenderReportRunDocument: the run outlives the
 * request, `updatedAt` doubles as the heartbeat, and the unique index makes
 * claiming race-safe.
 */
export interface DocumentBriefRunDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  documentId: ObjectId;
  status: "running" | "done" | "failed";
  /** Which step the run is on; meaningless unless `status` is "running". */
  stage:
    | "saving_editor"
    | "extracting"
    | "grounding"
    | "analyzing"
    | "translating"
    | "saving";
  startedByUserId: string;
  /** i18n key ("rate_limited" | "invalid_output" | "failed"), never raw. */
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Extracted text of one committed workspace-document version, cached so Dora
 * re-reads are free. `_id` is the idempotency key `wdoc:{documentId}:{sha256}`
 * — a new version has a new sha and therefore a new row; old rows are pruned
 * on write (latest few kept for quick version flips).
 */
export interface WorkspaceDocumentTextDocument {
  _id: string;
  tenantId: ObjectId;
  documentId: ObjectId;
  versionId: ObjectId;
  sha256: string;
  status: "ready" | "unsupported" | "failed";
  /** "native" = unpdf/mammoth; "converted-csv" = spreadsheet via DS
   * converter; "gaeb-projection" = structured BOQ projection via lib/gaeb. */
  source: "native" | "converted-csv" | "gaeb-projection" | null;
  /** Limitation marker ("no_text_layer" | "first_sheet_only" | error slug). */
  note: string | null;
  text: string;
  chars: number;
  truncated: boolean;
  extractedAt: Date;
}

/**
 * The company rendered as query vectors, for AI tender matching.
 *
 * Deliberately many small vectors rather than one: a single centroid over
 * "we build roofs" and "our surety is X" resembles neither, and retrieves
 * generically. Facets keep the company's distinct capabilities apart, and the
 * facet that won a match is what the UI shows as "matched via …".
 *
 * Lives here rather than as a field on `companies` because ~100KB of floats
 * would be dragged into every Mongoose company read.
 */
export interface CompanyMatchProfileDocument {
  _id?: ObjectId;
  /** Company._id. */
  tenantId: ObjectId;
  /** hashCompanyData(profile, embeddedDocs) — reused verbatim from lib/ai/fit. */
  companyDataHash: string;
  profileVersion: string;
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;

  facets: Array<{
    /** "capabilities" | "narrative" | `reference:${i}` | `doc:${recordId}` */
    key: string;
    kind: "profile" | "document";
    /** Document filename / reference-project title; shown in "matched via". */
    label: string | null;
    weight: number;
    text: string;
    sourceHash: string;
    embedding: number[];
  }>;

  /** Denormalized so retrieval never has to re-read `companies`. */
  scope: {
    countries: string[];
    nuts: { country: string; nuts1?: string; nuts2?: string; nuts3?: string };
    /** Check digits stripped, ready to compare against `tenders.cpvCodes`. */
    cpvCodes: string[];
  };

  /** What we could not build and why — drives the "improve matching" nudge. */
  skipped: Array<{ key: string; reason: "too_short" | "absent" }>;

  builtAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One scored (company, tender) pair — the persisted AI Matched feed.
 *
 * Rows are tagged with the `runId` that wrote them and readers pin to the
 * run's `lastCompletedRunId`, so a refresh can rebuild the whole set
 * underneath a user who is paging through it without ever showing them a
 * half-old, half-new page.
 */
export interface TenderMatchScoreDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  tenderId: ObjectId;
  runId: ObjectId;
  rank: number;

  /** Pre-judge blend of semantic + rule signals, 0..1. */
  matchScore: number;
  /** LLM fit, 0..100. Null until the judging phase runs (or if it failed). */
  fitScore: number | null;
  /** What the feed sorts on: matchScore alone, or blended with fitScore. */
  finalScore: number;
  confidence: "low" | "medium" | "high" | null;

  signals: {
    semantic: number;
    /** Raw $meta:"vectorSearchScore" before band normalization — for calibration. */
    semanticRaw: number;
    rule: number;
    cpv: number;
    /**
     * Rank-decayed notice-text match against the company profile, 0..1.
     * Optional: rows persisted before the text arm existed do not carry it —
     * readers must treat absence as 0.
     */
    text?: number;
    geo: number;
    time: number;
    fused: number;
  };

  /** Which company facets retrieved this tender; the explainability payload. */
  matchedFacets: Array<{
    key: string;
    kind: "profile" | "document";
    label: string | null;
    score: number;
  }>;

  /** Written bilingually in one pass so de/en can never disagree. */
  reasons: { en: string; de: string } | null;
  matchedCapabilities: string[];
  concerns: string[];

  /** Staleness triple, mirrored onto the row so a single read can check it. */
  companyDataHash: string;
  promptVersion: string;
  pipelineVersion: string;
  embeddingIdentity: string;
  model: { provider: string; providerModel: string } | null;

  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * An in-flight (or just-finished) match refresh, one per company.
 *
 * Same reasoning as `TenderReportRunDocument`: the work outlives the request
 * that started it, so "is something running and how far is it" has to be
 * server state. That is what makes the progress UI resumable across a reload
 * and what stops two readers from paying for the same refresh twice.
 *
 * `updatedAt` doubles as a heartbeat.
 */
export interface CompanyMatchRunDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  status: "running" | "done" | "failed";
  stage: "building_profile" | "retrieving" | "fusing" | "judging" | "finalizing";
  /** Judge batch progress; meaningless outside the "judging" stage. */
  progress: { done: number; total: number };
  trigger: "manual" | "profile_change" | "sweep" | "new_tenders";

  /** The run currently writing rows. */
  runId: ObjectId;
  /** What readers pin to. Flipped atomically once the new rows are all in. */
  lastCompletedRunId: ObjectId | null;

  companyDataHash: string;
  promptVersion: string;
  pipelineVersion: string;
  embeddingIdentity: string;

  scoredCount: number;
  judgedCount: number;
  startedByUserId: string | null;
  /** i18n key ("rate_limited" | "search_unavailable" | "failed"), never raw. */
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Durable ledger for document-derived work (chunking, chunk embedding,
 * classification, extraction). `_id` is the idempotency key (§10.3), e.g.
 * `chunk:doc:{documentRecordId}:{fileSha256}:{chunkerVersion}`.
 */
export interface AiIndexStateDocument {
  _id: string;
  kind:
    | "doc_chunks"
    | "chunk_embed"
    | "doc_class"
    | "extract_schema"
    | "company_doc_embed";
  /** The tender_documents._id this state belongs to. */
  refId: string;
  sourceHash: string;
  status: AiIndexStatus;
  attempts: number;
  error: string | null;
  chunkCount: number | null;
  updatedAt: Date;
}
