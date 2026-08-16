import { createHash, randomUUID } from "node:crypto";

import { getIngestionDb } from "@/lib/ingestion/db/client";

import {
  doraEditorSnapshotInputSchema,
  type DoraEditorSnapshotInput,
  type StoredDoraSnapshot,
} from "./snapshot-schema";

const COLLECTION = "dora_document_snapshots";
const SNAPSHOT_TTL_MS = 15 * 60 * 1_000;
let indexesReady: Promise<void> | null = null;

function canonicalSnapshot(value: DoraEditorSnapshotInput): string {
  return JSON.stringify({
    version: value.version,
    editorKey: value.editorKey,
    mode: value.mode,
    nodes: value.nodes,
    selection: value.selection ?? null,
    styles: value.styles,
    capabilities: value.capabilities,
  });
}

export function snapshotHash(value: DoraEditorSnapshotInput): string {
  return createHash("sha256").update(canonicalSnapshot(value), "utf8").digest("hex");
}

async function ensureIndexes(): Promise<void> {
  indexesReady ??= (async () => {
    const db = await getIngestionDb();
    const collection = db.collection<StoredDoraSnapshot>(COLLECTION);
    await collection.createIndexes([
      { key: { expiresAt: 1 }, name: "ttl_snapshot", expireAfterSeconds: 0 },
      { key: { tenantId: 1, documentId: 1, createdAt: -1 }, name: "ix_document_recent" },
    ]);
  })();
  return indexesReady;
}

export function doraEditEngineV2Enabled(): boolean {
  return process.env.DORA_EDIT_ENGINE_V2 === "true";
}

export async function storeDoraSnapshot(input: {
  tenantId: string;
  documentId: string;
  userId: string;
  snapshot: unknown;
}): Promise<StoredDoraSnapshot> {
  const snapshot = doraEditorSnapshotInputSchema.parse(input.snapshot);
  await ensureIndexes();
  const now = new Date();
  const stored: StoredDoraSnapshot = {
    ...snapshot,
    _id: randomUUID(),
    tenantId: input.tenantId,
    documentId: input.documentId,
    userId: input.userId,
    snapshotHash: snapshotHash(snapshot),
    createdAt: now,
    expiresAt: new Date(now.getTime() + SNAPSHOT_TTL_MS),
  };
  const db = await getIngestionDb();
  await db.collection<StoredDoraSnapshot>(COLLECTION).insertOne(stored);
  return stored;
}

export async function getDoraSnapshot(input: {
  snapshotId: string;
  tenantId: string;
  documentId: string;
  userId: string;
}): Promise<StoredDoraSnapshot | null> {
  const db = await getIngestionDb();
  return db.collection<StoredDoraSnapshot>(COLLECTION).findOne({
    _id: input.snapshotId,
    tenantId: input.tenantId,
    documentId: input.documentId,
    userId: input.userId,
    expiresAt: { $gt: new Date() },
  });
}
