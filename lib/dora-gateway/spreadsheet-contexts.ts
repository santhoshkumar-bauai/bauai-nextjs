import { createHash, randomUUID } from "node:crypto";

import { getIngestionDb } from "@/lib/ingestion/db/client";

import {
  spreadsheetContextInputSchema,
  type SpreadsheetContextInput,
  type StoredSpreadsheetContext,
} from "./spreadsheet-schema";

const COLLECTION = "dora_spreadsheet_contexts";
const CONTEXT_TTL_MS = 15 * 60 * 1_000;
let indexesReady: Promise<void> | null = null;

function canonicalContext(value: SpreadsheetContextInput): string {
  return JSON.stringify({
    version: value.version,
    editorKey: value.editorKey,
    workbookRevision: value.workbookRevision,
    active: value.active,
    sheets: value.sheets,
    selection: value.selection ?? null,
    capabilities: value.capabilities,
  });
}

export function spreadsheetContextHash(value: SpreadsheetContextInput): string {
  return createHash("sha256").update(canonicalContext(value), "utf8").digest("hex");
}

async function ensureIndexes(): Promise<void> {
  indexesReady ??= (async () => {
    const db = await getIngestionDb();
    const collection = db.collection<StoredSpreadsheetContext>(COLLECTION);
    await collection.createIndexes([
      { key: { expiresAt: 1 }, name: "ttl_spreadsheet_context", expireAfterSeconds: 0 },
      {
        key: { tenantId: 1, documentId: 1, userId: 1, createdAt: -1 },
        name: "ix_spreadsheet_context_recent",
      },
    ]);
  })();
  return indexesReady;
}

export async function storeSpreadsheetContext(input: {
  tenantId: string;
  documentId: string;
  userId: string;
  context: unknown;
}): Promise<StoredSpreadsheetContext> {
  const context = spreadsheetContextInputSchema.parse(input.context);
  await ensureIndexes();
  const now = new Date();
  const stored: StoredSpreadsheetContext = {
    ...context,
    _id: randomUUID(),
    tenantId: input.tenantId,
    documentId: input.documentId,
    userId: input.userId,
    contextHash: spreadsheetContextHash(context),
    createdAt: now,
    expiresAt: new Date(now.getTime() + CONTEXT_TTL_MS),
  };
  const db = await getIngestionDb();
  await db.collection<StoredSpreadsheetContext>(COLLECTION).insertOne(stored);
  return stored;
}

export async function getSpreadsheetContext(input: {
  contextId: string;
  tenantId: string;
  documentId: string;
  userId: string;
}): Promise<StoredSpreadsheetContext | null> {
  const db = await getIngestionDb();
  return db.collection<StoredSpreadsheetContext>(COLLECTION).findOne({
    _id: input.contextId,
    tenantId: input.tenantId,
    documentId: input.documentId,
    userId: input.userId,
    expiresAt: { $gt: new Date() },
  });
}
