/**
 * Tender document retrieval contracts.
 *
 * A tender's `documents[].url` usually points at a buyer portal landing page rather
 * than a file: measured over one German publication day, 478 of 559 document URLs
 * (86%) had no file extension. Turning a landing page into files is per-platform
 * work, so the pipeline is split into resolve (find the files) and fetch (download,
 * store, extract text).
 */
import type { ObjectId } from "mongodb";

import type { TenderSourceCode } from "../types.ts";

export type DocumentStatus =
  | "PENDING"
  | "RESOLVING"
  | "FETCHED"
  | "SKIPPED"
  | "FAILED";

/**
 * Why no files were retrieved. Recorded rather than retried forever, and specific
 * enough to tell a portal that needs an account from a resolver that needs writing.
 */
export type DocumentSkipReason =
  | "LOGIN_REQUIRED"
  | "RESTRICTED"
  | "NO_FILES_FOUND"
  | "UNSUPPORTED_PLATFORM"
  | "TENDER_NOT_BIDDABLE"
  | "TOO_LARGE";

export type TextStatus = "PENDING" | "DONE" | "UNSUPPORTED" | "FAILED";

/** A file a resolver found and believes is downloadable. */
export interface ResolvedFile {
  url: string;
  /** Portal-supplied name when available; otherwise derived from the URL. */
  fileName: string | null;
  /** Only set when the portal states it; the real type comes from the response. */
  declaredMimeType?: string | null;
  /** Free-form label from the portal, e.g. "Leistungsverzeichnis". */
  label?: string | null;
  /**
   * Page this link was found on. Some portals reject a download whose Referer is not
   * the page that rendered it, which is the norm for framework callback links.
   */
  referer?: string;
}

export interface StoredDocumentFile {
  url: string;
  fileName: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  s3: { bucket: string; key: string };
  /** Set when this file came out of a ZIP bundle rather than its own request. */
  archivePath?: string;
  textStatus: TextStatus;
  textChars: number;
  /** Full extracted text always lives in S3; Mongo holds at most a capped copy. */
  textS3Key: string | null;
  text: string | null;
  textError?: string;
}

/** One resolved file that could not be stored, with enough detail to act on it. */
export interface FailedDocumentFile {
  url: string;
  fileName: string | null;
  label: string | null;
  /** `IngestionError` failure class, or the thrown error's name. */
  errorClass: string;
  error: string;
  /** False for a permanent refusal such as 404 or an over-size file. */
  retryable: boolean;
  attemptedAt: Date;
}

export interface TenderDocumentRecord {
  _id: string;
  tenderId: ObjectId;
  canonicalKey: string;
  source: TenderSourceCode;
  sourceNoticeId: string;
  /** The official URL from the notice. Always kept, whatever the outcome. */
  sourceUrl: string;
  host: string;
  platform: string | null;
  /** The notice's own `restricted-document` flag; such documents are never fetched. */
  restricted: boolean;
  status: DocumentStatus;
  skipReason: DocumentSkipReason | null;
  files: StoredDocumentFile[];
  /**
   * Files that were resolved but could not be retrieved.
   *
   * Kept because a row with one good file and four failures is still `FETCHED`, and
   * without this the failures would exist only in the process log — which is not an
   * audit trail. Every resolved file therefore ends up in exactly one of `files` or
   * `failedFiles`.
   */
  failedFiles: FailedDocumentFile[];
  attempts: number;
  leaseOwner: string | null;
  heartbeatAt: Date | null;
  nextAttemptAt: Date;
  error: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/* -------------------------------------------------------------------------- */
/* Resolver contract                                                          */
/* -------------------------------------------------------------------------- */

export type ResolveOutcome =
  | { files: ResolvedFile[] }
  | { skip: DocumentSkipReason; detail?: string };

export interface ResolveContext {
  url: URL;
  http: DocumentFetcher;
  signal?: AbortSignal;
}

/**
 * Minimal surface a resolver needs, so resolvers stay testable against fixtures
 * without a network or an S3 client.
 */
export interface DocumentFetcher {
  html(url: string, signal?: AbortSignal): Promise<{ body: string; finalUrl: string }>;
  head(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ status: number; mimeType: string; byteLength: number | null }>;
}

export interface DocumentResolver {
  /** Platform family, e.g. `cosinex`. Recorded on the document row. */
  readonly platform: string;
  matches(url: URL): boolean;
  resolve(context: ResolveContext): Promise<ResolveOutcome>;
}

export function isSkip(
  outcome: ResolveOutcome,
): outcome is { skip: DocumentSkipReason; detail?: string } {
  return "skip" in outcome;
}
