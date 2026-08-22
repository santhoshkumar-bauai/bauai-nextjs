import type { ObjectId } from "mongodb";
import { ObjectId as ObjectIdCtor } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";
import type { GaebItem } from "@/lib/gaeb/types";

import type { DocumentFillEvidence } from "../types";

/**
 * Layer B of the GAEB data model: one row per position per fill run — the
 * engine's immutable audit record. Batched writes keep progress resumable and
 * the polled run document small; user decisions land in the price sheet, never
 * here.
 */

export type GaebFillItemStatus = "pending" | "classified" | "priced" | "failed" | "skipped";

export interface GaebFillClassification {
  trade: string;
  workCategory: string;
  attributes: string[];
  /** Manufacturer/product names for web price lookups ("Geberit Mapress DN20"). */
  productMentions: string[];
}

export interface GaebFillSuggestion {
  unitPrice: number;
  rangeLow: number;
  rangeHigh: number;
  confidence: number;
  assumptions: string[];
  risks: string[];
  evidence: DocumentFillEvidence[];
  reason: string;
}

export interface GaebFillItemDocument {
  _id: ObjectId;
  runId: ObjectId;
  tenantId: ObjectId;
  documentId: ObjectId;
  itemKey: string;
  oz: string;
  batchIndex: number;
  status: GaebFillItemStatus;
  classification: GaebFillClassification | null;
  suggestion: GaebFillSuggestion | null;
  error: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Seeds one pending row per position. Idempotent: re-entry after a crash or a
 * queue retry inserts only the missing keys (unordered insert against the
 * unique `(runId, itemKey)` index).
 */
export async function seedGaebFillItems(input: {
  runId: ObjectId;
  tenantId: ObjectId;
  documentId: ObjectId;
  items: ReadonlyArray<Pick<GaebItem, "key" | "oz">>;
  batchSize: number;
}): Promise<void> {
  const { gaebFillItems } = await getAiCollections();
  const now = new Date();
  const rows: GaebFillItemDocument[] = input.items.map((item, index) => ({
    _id: new ObjectIdCtor(),
    runId: input.runId,
    tenantId: input.tenantId,
    documentId: input.documentId,
    itemKey: item.key,
    oz: item.oz,
    batchIndex: Math.floor(index / input.batchSize),
    status: "pending",
    classification: null,
    suggestion: null,
    error: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }));
  if (rows.length === 0) return;
  try {
    await gaebFillItems.insertMany(rows, { ordered: false });
  } catch (error) {
    // Duplicate keys are the idempotent path; anything else is real.
    const code = (error as { code?: number }).code;
    if (code !== 11000) throw error;
  }
}

export async function listGaebFillItems(
  runId: ObjectId,
  filter?: { status?: GaebFillItemStatus | GaebFillItemStatus[] },
): Promise<GaebFillItemDocument[]> {
  const { gaebFillItems } = await getAiCollections();
  const statuses = filter?.status
    ? Array.isArray(filter.status)
      ? filter.status
      : [filter.status]
    : null;
  return gaebFillItems
    .find(statuses ? { runId, status: { $in: statuses } } : { runId })
    .sort({ batchIndex: 1, itemKey: 1 })
    .toArray();
}

export async function countGaebFillItems(
  runId: ObjectId,
): Promise<Record<GaebFillItemStatus, number>> {
  const { gaebFillItems } = await getAiCollections();
  const rows = await gaebFillItems
    .aggregate<{ _id: GaebFillItemStatus; count: number }>([
      { $match: { runId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();
  const counts: Record<GaebFillItemStatus, number> = {
    pending: 0,
    classified: 0,
    priced: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

export async function bulkPatchGaebFillItems(
  runId: ObjectId,
  patches: Array<{
    itemKey: string;
    status?: GaebFillItemStatus;
    classification?: GaebFillClassification | null;
    suggestion?: GaebFillSuggestion | null;
    error?: string | null;
    incrementAttempts?: boolean;
  }>,
): Promise<void> {
  if (patches.length === 0) return;
  const { gaebFillItems } = await getAiCollections();
  const now = new Date();
  await gaebFillItems.bulkWrite(
    patches.map((patch) => {
      const set: Record<string, unknown> = { updatedAt: now };
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.classification !== undefined) set.classification = patch.classification;
      if (patch.suggestion !== undefined) set.suggestion = patch.suggestion;
      if (patch.error !== undefined) set.error = patch.error;
      return {
        updateOne: {
          filter: { runId, itemKey: patch.itemKey },
          update: patch.incrementAttempts
            ? { $set: set, $inc: { attempts: 1 } }
            : { $set: set },
        },
      };
    }),
    { ordered: false },
  );
}

/** Flips failed rows back to pending for a retry pass. */
export async function resetFailedGaebFillItems(runId: ObjectId): Promise<number> {
  const { gaebFillItems } = await getAiCollections();
  const result = await gaebFillItems.updateMany(
    { runId, status: "failed" },
    { $set: { status: "pending", error: null, updatedAt: new Date() } },
  );
  return result.modifiedCount;
}

export function serializeGaebFillItem(item: GaebFillItemDocument) {
  return {
    itemKey: item.itemKey,
    oz: item.oz,
    batchIndex: item.batchIndex,
    status: item.status,
    classification: item.classification,
    suggestion: item.suggestion,
    error: item.error,
    updatedAt: item.updatedAt.toISOString(),
  };
}
