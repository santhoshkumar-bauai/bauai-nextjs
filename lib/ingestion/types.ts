/**
 * Canonical ingestion contracts shared by adapters, workers, and the writer.
 *
 * See MONGODB_TENDER_SEEDING_AND_INGESTION_ARCHITECTURE.md sections 5, 6 and 8.
 */
import type { Decimal128, ObjectId } from "mongodb";

export type TenderSourceCode =
  | "DE_BUND"
  | "TED"
  | "NL_TENDERNED"
  | "FR_BOAMP"
  | "ES_PLACSP"
  | "PL_BZP"
  | "UK_FTS"
  | "UK_CF"
  | "PT_BASE"
  | "IT_ANAC"
  | "IE_ETENDERS";

export type IngestionMode = "live" | "reconciliation" | "backfill";

export type SourcePriority = "required" | "wave1" | "wave2" | "wave3";

/** Business categories from architecture section 7. */
export type BusinessCategory =
  | "OPEN_OPPORTUNITY"
  | "OPEN_OR_EARLY_COMPETITION"
  | "UPCOMING_OPPORTUNITY"
  | "MARKET_CONSULTATION"
  | "AWARD_RESULT"
  | "CONTRACT_UPDATE"
  | "COMPLETED_CONTRACT"
  | "DIRECT_AWARD_NOTICE"
  | "BUSINESS_REGISTRATION_NOTICE"
  | "UNKNOWN";

/** Current tender statuses from architecture section 7. */
export type TenderStatus =
  | "UPCOMING"
  | "OPEN"
  | "CLOSING_SOON"
  | "CLOSED"
  | "AWARDED"
  | "CANCELLED"
  | "MODIFIED"
  | "COMPLETED"
  | "DIRECT_AWARD"
  | "UNKNOWN";

export type ValidationStatus = "VALID" | "VALID_WITH_WARNINGS" | "QUARANTINED";

export type ProcessingOutcome =
  | "INSERTED"
  | "UPDATED"
  | "UNCHANGED"
  | "QUARANTINED";

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A cursor is persisted per source *and* mode so live discovery, nightly
 * reconciliation, and backfill never overwrite each other (section 6.3).
 */
export interface DiscoveryCursor {
  source: TenderSourceCode;
  mode: IngestionMode;
  /** Highest source publication/update time durably accepted by the queue. */
  watermark: Date | null;
  /** Opaque source pagination state (TED iteration token, page number, ...). */
  pageOrToken: string | null;
  lastOfficialId: string | null;
  /** Explicit window for reconciliation and backfill partitions. */
  windowFrom: Date | null;
  windowTo: Date | null;
  /** Conditional-request validators so an unchanged archive is not reprocessed. */
  etag: string | null;
  lastModified: string | null;
}

/**
 * The minimum identity a source must supply before a job may be enqueued.
 * Anything without `sourceNoticeId` is quarantined rather than given a random
 * id, which would duplicate on every run (section 11.1).
 */
export interface DiscoveredNotice {
  source: TenderSourceCode;
  sourceNoticeId: string;
  /** Official version when supplied; the pipeline derives one otherwise. */
  sourceVersionId: string | null;
  /** Stable version discriminator: version id, publication id, or content hash. */
  versionKey: string | null;
  publicationNumber: string | null;
  procedureId: string | null;
  url: string | null;
  publishedAt: Date | null;
  updatedAtSource: Date | null;
  /**
   * Payload the adapter already holds. Set when discovery and content arrive
   * together (a zip entry, or a TED search hit), letting the worker skip a
   * second network round trip.
   */
  inlinePayload?: {
    body: Buffer;
    mimeType: string;
  };
  /** Free-form adapter state carried to `fetch`, never persisted as identity. */
  fetchHint?: Record<string, string>;
}

export interface RawNotice {
  source: TenderSourceCode;
  sourceNoticeId: string;
  body: Buffer;
  mimeType: string;
  sha256: string;
  byteLength: number;
  fetchedAt: Date;
  url: string | null;
  /** Adapter-declared licence identifier recorded on every notice (section 16). */
  licence: string;
}

/* -------------------------------------------------------------------------- */
/* Canonical parsed notice                                                    */
/* -------------------------------------------------------------------------- */

export interface LocalizedText {
  original: string | null;
  language: string | null;
  translations: Record<string, string>;
}

export interface CanonicalAddress {
  streetName: string | null;
  city: string | null;
  postalCode: string | null;
  nutsCode: string | null;
  countryCode: string | null;
}

export interface CanonicalBuyer {
  name: string | null;
  identifiers: string[];
  email: string | null;
  phone: string | null;
  website: string | null;
  legalType: string | null;
  activityType: string | null;
  address: CanonicalAddress | null;
}

export interface CanonicalMoney {
  amount: number | null;
  currency: string | null;
}

/**
 * Which official period the deadline came from. Restricted and negotiated
 * procedures publish a request-to-participate deadline instead of a tender
 * deadline, and the UI must not label one as the other.
 */
export type DeadlineKind = "TENDER" | "PARTICIPATION_REQUEST" | "NONE";

export interface CanonicalLot {
  lotId: string;
  title: string | null;
  description: string | null;
  cpvCodes: string[];
  estimatedValue: CanonicalMoney | null;
  submissionDeadline: Date | null;
  deadlineKind: DeadlineKind;
  contractNature: string | null;
  locations: CanonicalAddress[];
}

export interface CanonicalDocument {
  url: string;
  kind: string | null;
  language: string | null;
  restricted: boolean;
}

export interface SourceNoticeIdentity {
  code: TenderSourceCode;
  noticeId: string;
  versionId: string | null;
  versionKey: string;
  publicationNumber: string | null;
  procedureId: string | null;
  url: string | null;
  licence: string;
}

export interface NoticeClassification {
  typeCode: string;
  subtypeCode: string | null;
  formType: string | null;
  businessCategory: BusinessCategory;
  isPotentiallyBiddable: boolean;
}

/** Output of `TenderSourceAdapter.parse`, before persistence. */
export interface SourceNotice {
  source: SourceNoticeIdentity;
  publication: {
    publishedAt: Date | null;
    updatedAtSource: Date | null;
    languages: string[];
  };
  notice: NoticeClassification;
  snapshot: {
    title: LocalizedText;
    description: LocalizedText;
    buyer: CanonicalBuyer | null;
    lots: CanonicalLot[];
    cpvCodes: string[];
    locations: CanonicalAddress[];
    countries: string[];
    regions: string[];
    value: CanonicalMoney | null;
    submissionDeadline: Date | null;
    deadlineKind: DeadlineKind;
    procedureType: string | null;
    contractNature: string | null;
    documents: CanonicalDocument[];
    /** Official ids of previous/changed/modified notices, for safe linking. */
    relatedNoticeIds: Array<{ scheme: string; value: string }>;
    isCancelled: boolean;
    isAwarded: boolean;
  };
  processing: {
    parserVersion: string;
    schemaVersion: number;
    validationStatus: ValidationStatus;
    warnings: string[];
  };
}

/* -------------------------------------------------------------------------- */
/* Adapter contract (section 5.1)                                             */
/* -------------------------------------------------------------------------- */

export interface SourceAccessReport {
  source: TenderSourceCode;
  reachable: boolean;
  httpStatus: number | null;
  detail: string;
  checkedAt: Date;
}

export interface DiscoveryBatch {
  notices: DiscoveredNotice[];
  /** Cursor to persist *after* every notice in this batch is queued. */
  nextCursor: DiscoveryCursor;
  /** True when the source reported no change (ETag/Last-Modified match). */
  unchanged: boolean;
  httpStatus: number | null;
  /** Archive-level provenance for reconciliation manifests (section 6.4). */
  archive?: { checksum: string; byteLength: number; entryCount: number };
}

export interface TenderSourceAdapter {
  readonly code: TenderSourceCode;
  readonly licence: string;
  readonly parserVersion: string;

  checkAccess(): Promise<SourceAccessReport>;
  /** Yields batches so the caller can checkpoint per page rather than per run. */
  discover(cursor: DiscoveryCursor): AsyncIterable<DiscoveryBatch>;
  fetch(ref: DiscoveredNotice): Promise<RawNotice>;
  parse(raw: RawNotice, ref: DiscoveredNotice): Promise<SourceNotice>;
}

/* -------------------------------------------------------------------------- */
/* Queue payloads                                                             */
/* -------------------------------------------------------------------------- */

export type QueueName =
  | "live"
  | "reconciliation"
  | "backfill"
  | "enrichment"
  | "dead-letter";

/** One notice to fetch, parse, and persist. */
export interface NoticeJob {
  kind: "notice";
  source: TenderSourceCode;
  mode: IngestionMode;
  /** Stable job key: `source:sourceNoticeId:versionKey` (section 5.1). */
  jobKey: string;
  notice: DiscoveredNotice;
  runId: string | null;
  attempt: number;
  /**
   * Set when the payload was staged to object storage instead of carried inline.
   * Backfill partitions contain tens of thousands of notices, and keeping their
   * bytes in Redis would turn the queue into a data store (§5.1).
   */
  stagedPayload?: RawPayloadRef;
}

/** One discovery window for the scheduler to expand into notice jobs. */
export interface DiscoveryJob {
  kind: "discovery";
  source: TenderSourceCode;
  mode: IngestionMode;
  jobKey: string;
  windowFrom: string | null;
  windowTo: string | null;
  /** Source-specific partition label, e.g. `pubDay=2026-08-04`. */
  partition: string | null;
  attempt: number;
}

export type IngestionJob = NoticeJob | DiscoveryJob;

/* -------------------------------------------------------------------------- */
/* Persisted document shapes                                                  */
/* -------------------------------------------------------------------------- */

export interface SourceConfigDocument {
  _id: TenderSourceCode;
  enabled: boolean;
  priority: SourcePriority;
  liveIntervalSeconds: number;
  reconciliationIntervalSeconds: number;
  overlapSeconds: number;
  maxConcurrentRequests: number;
  requestTimeoutMs: number;
  rateLimitPerMinute: number;
  reconciliationDays: number;
  /** Historical horizon in months; configuration, never hard-coded (§9.1). */
  backfillHorizonMonths: number;
  jitterRatio: number;
  circuitBreakerThreshold: number;
  parserVersion: string;
  licence: string;
  updatedAt: Date;
}

export interface SourceCheckpointDocument {
  _id: string;
  source: TenderSourceCode;
  mode: IngestionMode;
  watermark: Date | null;
  pageOrToken: string | null;
  lastOfficialId: string | null;
  overlapFrom: Date | null;
  windowFrom: Date | null;
  windowTo: Date | null;
  etag: string | null;
  lastModified: string | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  consecutiveFailures: number;
  circuitOpenUntil: Date | null;
  lastSuccessfulRunAt: Date | null;
  /**
   * When this source/mode may next run. Persisted rather than kept in memory so
   * the interval survives a restart and is shared across replicas (§5.1).
   */
  nextRunAt: Date | null;
  updatedAt: Date;
}

export interface IngestionRunCounters {
  discovered: number;
  fetched: number;
  unchanged: number;
  inserted: number;
  updated: number;
  rejected: number;
  retried: number;
  deadLettered: number;
}

export interface IngestionRunDocument {
  _id: string;
  source: TenderSourceCode;
  mode: IngestionMode;
  partition: string | null;
  windowFrom: Date | null;
  windowTo: Date | null;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "UNCHANGED" | "STALE";
  startedAt: Date;
  heartbeatAt: Date;
  completedAt: Date | null;
  httpStatus: number | null;
  archiveChecksum: string | null;
  archiveByteLength: number | null;
  parserVersion: string;
  counters: IngestionRunCounters;
  error: { name: string; message: string; retryable: boolean } | null;
  worker: string;
}

export interface RawPayloadRef {
  storage: "s3";
  bucket: string;
  key: string;
  mimeType: string;
  compression: "gzip" | "none";
  byteLength: number;
  sha256: string;
}

export interface TenderNoticeDocument {
  _id: ObjectId;
  source: SourceNoticeIdentity;
  identity: { idempotencyKey: string; contentSha256: string };
  publication: {
    publishedAt: Date | null;
    updatedAtSource: Date | null;
    discoveredAt: Date;
    fetchedAt: Date;
    languages: string[];
  };
  notice: NoticeClassification;
  snapshot: SourceNotice["snapshot"];
  raw: RawPayloadRef;
  processing: SourceNotice["processing"];
  createdAt: Date;
}

export interface TenderNoticeRef {
  noticeId: ObjectId;
  source: TenderSourceCode;
  sourceNoticeId: string;
  versionKey: string;
  typeCode: string;
  publishedAt: Date | null;
}

export interface TenderDocument {
  _id: ObjectId;
  canonicalKey: string;
  status: TenderStatus;
  businessCategory: BusinessCategory;
  isVisible: boolean;
  title: string | null;
  description: string | null;
  language: string | null;
  buyer: (CanonicalBuyer & { location?: GeoPoint }) | null;
  lots: CanonicalLot[];
  cpvCodes: string[];
  countries: string[];
  regions: string[];
  estimatedValue: { amount: Decimal128 | null; currency: string | null } | null;
  procedureType: string | null;
  contractNature: string | null;
  publicationDate: Date | null;
  submissionDeadline: Date | null;
  documents: CanonicalDocument[];
  currentNoticeId: ObjectId;
  currentVersionKey: string;
  noticeRefs: TenderNoticeRef[];
  sourceLinks: Array<{ source: TenderSourceCode; url: string | null; licence: string }>;
  relatedNoticeIds: Array<{ scheme: string; value: string }>;
  dataQuality: { score: number; warnings: string[] };
  enrichment: {
    geocoding: EnrichmentState;
    translation: EnrichmentState;
    embedding: EnrichmentState;
  };
  aggregateVersion: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface GeoPoint {
  type: "Point";
  coordinates: [number, number];
}

export interface EnrichmentState {
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";
  updatedAt?: Date;
  error?: string;
}

export type OutboxEventType =
  | "TENDER_CREATED"
  | "TENDER_UPDATED"
  | "TENDER_STATUS_CHANGED";

export interface OutboxEventDocument {
  _id: ObjectId;
  eventType: OutboxEventType;
  aggregateId: ObjectId;
  aggregateVersion: number;
  payload: {
    canonicalKey: string;
    status: TenderStatus;
    businessCategory: BusinessCategory;
    cpvCodes: string[];
    countries: string[];
    regions: string[];
    submissionDeadline: Date | null;
    publicationDate: Date | null;
    sources: TenderSourceCode[];
    /** Historical backfill inserts must not trigger user alerts (§9.4). */
    suppressNotifications: boolean;
  };
  createdAt: Date;
  deliveredAt: Date | null;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
}

export interface DeadLetterDocument {
  _id: ObjectId;
  source: TenderSourceCode;
  mode: IngestionMode;
  jobKey: string;
  sourceNoticeId: string | null;
  versionKey: string | null;
  errorClass: string;
  errorMessage: string;
  attempts: number;
  parserVersion: string;
  rawPayload: RawPayloadRef | null;
  job: IngestionJob;
  runId: string | null;
  replayStatus: "PENDING" | "REPLAYING" | "REPLAYED" | "PERMANENT";
  createdAt: Date;
  updatedAt: Date;
}

export interface RelayStateDocument {
  _id: string;
  resumeToken: unknown;
  updatedAt: Date;
}
