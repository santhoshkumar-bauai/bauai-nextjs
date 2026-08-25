import { ObjectId, type Collection } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import type { SandboxNativeField } from "./sandbox-client.ts";
import type { FillField, FillIssue, OpenQuestion } from "./fieldmap.ts";

/**
 * Fill-agent session store. Deliberately NOT registered in
 * lib/ai/db/collections.ts — the POC namespace owns its one collection, so
 * deleting the POC deletes this file, not a shared registry entry.
 *
 * The session is the durable state of a fill conversation: the source PDF
 * pin, the FIELDMAP (the artifact that outlives the chat), user-confirmed
 * values, and the server-held budgets the model cannot reset. The sandbox
 * workspace is a cache; everything here suffices to rebuild it.
 */

export type FillSessionStatus =
  | "ready"
  | "in_progress"
  | "filled"
  | "escalated"
  | "failed";

export interface FillAgentSessionDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  createdBy: string;
  /** Workspace document this session fills, when opened from the document
   * filler; null for direct POC uploads. Document-bound sessions REFERENCE
   * the document version's S3 object as their source — teardown must never
   * delete it. */
  documentId: ObjectId | null;
  status: FillSessionStatus;
  source: {
    s3Key: string;
    fileName: string;
    sha256: string;
    sizeBytes: number;
  };
  pdf: {
    documentClass: "acroform" | "digital" | "scanned";
    pageCount: number;
    manifestHash: string;
    acroFieldCount: number;
  };
  /** Ephemeral sidecar workspace id; null/stale is fine (rehydrated on demand). */
  sandboxSessionId: string | null;
  fieldmap: FillField[];
  /** Values the USER supplied in chat, by field id — the sensitivity
   * ratchet's allowlist and the audit trail of who said what. */
  values: Record<string, string>;
  openQuestions: OpenQuestion[];
  /** Sandbox-side AcroForm inventory captured at first analyze (top-left
   * coordinate space; the planner prompt consumes it verbatim). */
  nativeFields: SandboxNativeField[];
  fillIterations: number;
  maxFillIterations: number;
  targetScore: number;
  score: number | null;
  issues: FillIssue[];
  /** The vision critique runs once per session, and only after a clean
   * deterministic validate — server-enforced, not prompt-enforced. */
  critiqued: boolean;
  output: {
    s3Key: string;
    sha256: string;
    score: number;
    verifiedAt: Date;
  } | null;
  threadId: ObjectId | null;
  createdAt: Date;
  updatedAt: Date;
}

export const FILL_AGENT_SESSIONS_COLLECTION = "fill_agent_sessions";

let indexesEnsured = false;

export async function getFillSessionCollection(): Promise<
  Collection<FillAgentSessionDocument>
> {
  const db = await getIngestionDb();
  const collection = db.collection<FillAgentSessionDocument>(
    FILL_AGENT_SESSIONS_COLLECTION,
  );
  if (!indexesEnsured) {
    indexesEnsured = true;
    await Promise.all([
      collection.createIndex({ tenantId: 1, createdAt: -1 }),
      collection.createIndex({ tenantId: 1, documentId: 1 }),
    ]).catch(() => {}); // races with parallel routes are benign
  }
  return collection;
}

export async function createFillSession(input: {
  tenantId: ObjectId;
  createdBy: string;
  source: FillAgentSessionDocument["source"];
  pdf: FillAgentSessionDocument["pdf"];
  maxFillIterations: number;
  targetScore: number;
  documentId?: ObjectId | null;
}): Promise<FillAgentSessionDocument> {
  const collection = await getFillSessionCollection();
  const now = new Date();
  const doc: FillAgentSessionDocument = {
    tenantId: input.tenantId,
    createdBy: input.createdBy,
    documentId: input.documentId ?? null,
    status: "ready",
    source: input.source,
    pdf: input.pdf,
    sandboxSessionId: null,
    fieldmap: [],
    values: {},
    openQuestions: [],
    nativeFields: [],
    fillIterations: 0,
    maxFillIterations: input.maxFillIterations,
    targetScore: input.targetScore,
    score: null,
    issues: [],
    critiqued: false,
    output: null,
    threadId: null,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await collection.insertOne(doc);
  return { ...doc, _id: inserted.insertedId };
}

export async function getFillSession(
  tenantId: ObjectId,
  sessionId: ObjectId,
): Promise<FillAgentSessionDocument | null> {
  const collection = await getFillSessionCollection();
  return collection.findOne({ _id: sessionId, tenantId });
}

export async function listFillSessions(
  tenantId: ObjectId,
  limit = 25,
): Promise<FillAgentSessionDocument[]> {
  const collection = await getFillSessionCollection();
  return collection
    .find({ tenantId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
}

export async function updateFillSession(
  tenantId: ObjectId,
  sessionId: ObjectId,
  set: Partial<Omit<FillAgentSessionDocument, "_id" | "tenantId" | "createdAt">>,
): Promise<FillAgentSessionDocument | null> {
  const collection = await getFillSessionCollection();
  return collection.findOneAndUpdate(
    { _id: sessionId, tenantId },
    { $set: { ...set, updatedAt: new Date() } },
    { returnDocument: "after" },
  );
}

export async function deleteFillSession(
  tenantId: ObjectId,
  sessionId: ObjectId,
): Promise<void> {
  const collection = await getFillSessionCollection();
  await collection.deleteOne({ _id: sessionId, tenantId });
}

/** Wire shape for the POC UI. */
export function serializeFillSession(doc: FillAgentSessionDocument) {
  return {
    id: String(doc._id),
    status: doc.status,
    fileName: doc.source.fileName,
    sizeBytes: doc.source.sizeBytes,
    documentClass: doc.pdf.documentClass,
    pageCount: doc.pdf.pageCount,
    acroFieldCount: doc.pdf.acroFieldCount,
    fieldCount: doc.fieldmap.length,
    /** True once the sandbox analyzed the PDF — source page renders exist. */
    analyzed: doc.sandboxSessionId != null,
    openQuestions: doc.openQuestions,
    fillIterations: doc.fillIterations,
    maxFillIterations: doc.maxFillIterations,
    targetScore: doc.targetScore,
    score: doc.score,
    issueCounts: {
      errors: doc.issues.filter((issue) => issue.severity === "error").length,
      warnings: doc.issues.filter((issue) => issue.severity === "warning").length,
      infos: doc.issues.filter((issue) => issue.severity === "info").length,
    },
    critiqued: doc.critiqued,
    downloadReady: doc.output != null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export type SerializedFillSession = ReturnType<typeof serializeFillSession>;
