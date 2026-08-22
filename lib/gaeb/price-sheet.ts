import type { ObjectId } from "mongodb";
import { ObjectId as ObjectIdCtor } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";

import type { GaebPartyBlock } from "./types";

/**
 * Layer C of the GAEB data model: the user's working prices — the ONLY input
 * the X84 export reads. One sheet per workspace document, pinned to the
 * source bytes it was priced against. Dora's suggestions (Layer B) reach this
 * sheet exclusively through explicit user decisions.
 */

export type GaebPriceDecision = "accepted" | "edited" | "rejected" | "manual";

export interface GaebPriceEntry {
  /** Working unit price in euros; null = explicitly cleared / rejected. */
  unitPrice: number | null;
  decision: GaebPriceDecision | null;
  /** Fill run the accepted/edited value came from, for provenance. */
  suggestionRunId: string | null;
  note: string | null;
  updatedAt: Date;
  updatedBy: string;
}

export interface GaebPriceSheetDocument {
  _id: ObjectId;
  tenantId: ObjectId;
  documentId: ObjectId;
  /** The bytes these prices belong to. Writes against other bytes are 409s. */
  sourceSha256: string;
  /** Keyed by parser item key ("i-0001") — dot-free, so Mongo-path safe. */
  prices: Record<string, GaebPriceEntry>;
  /** Bidder block for the X84 export; edited via the fill meta fields. */
  bidder: GaebPartyBlock | null;
  createdAt: Date;
  updatedAt: Date;
}

const ITEM_KEY = /^i-\d{4,8}$/;

export interface GaebPriceUpdate {
  itemKey: string;
  unitPrice?: number | null;
  decision?: GaebPriceDecision | null;
  suggestionRunId?: string | null;
  note?: string | null;
}

export async function getPriceSheet(
  tenantId: ObjectId,
  documentId: ObjectId,
): Promise<GaebPriceSheetDocument | null> {
  const { gaebPriceSheets } = await getAiCollections();
  return gaebPriceSheets.findOne({ tenantId, documentId });
}

export type PatchPriceSheetResult =
  | { ok: true; sheet: GaebPriceSheetDocument }
  | { ok: false; error: "gaeb_source_changed" | "invalid_item_key" };

/**
 * Applies price/decision updates atomically via per-item dotted `$set`s, so
 * two concurrent PATCHes to different rows merge instead of clobbering.
 */
export async function patchPriceSheet(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  sourceSha256: string;
  userId: string;
  updates: GaebPriceUpdate[];
  bidder?: GaebPartyBlock | null;
}): Promise<PatchPriceSheetResult> {
  const { gaebPriceSheets } = await getAiCollections();
  const now = new Date();

  for (const update of input.updates) {
    if (!ITEM_KEY.test(update.itemKey)) return { ok: false, error: "invalid_item_key" };
  }

  const existing = await gaebPriceSheets.findOne({
    tenantId: input.tenantId,
    documentId: input.documentId,
  });
  if (existing && existing.sourceSha256 !== input.sourceSha256) {
    return { ok: false, error: "gaeb_source_changed" };
  }
  if (!existing) {
    const fresh: GaebPriceSheetDocument = {
      _id: new ObjectIdCtor(),
      tenantId: input.tenantId,
      documentId: input.documentId,
      sourceSha256: input.sourceSha256,
      prices: {},
      bidder: null,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await gaebPriceSheets.insertOne(fresh);
    } catch {
      // Concurrent creation — fall through to the update path below.
      const raced = await gaebPriceSheets.findOne({
        tenantId: input.tenantId,
        documentId: input.documentId,
      });
      if (raced && raced.sourceSha256 !== input.sourceSha256) {
        return { ok: false, error: "gaeb_source_changed" };
      }
    }
  }

  const sets: Record<string, unknown> = { updatedAt: now };
  for (const update of input.updates) {
    const previous = existing?.prices[update.itemKey];
    const entry: GaebPriceEntry = {
      unitPrice:
        update.unitPrice === undefined ? (previous?.unitPrice ?? null) : update.unitPrice,
      decision:
        update.decision === undefined ? (previous?.decision ?? null) : update.decision,
      suggestionRunId:
        update.suggestionRunId === undefined
          ? (previous?.suggestionRunId ?? null)
          : update.suggestionRunId,
      note: update.note === undefined ? (previous?.note ?? null) : update.note,
      updatedAt: now,
      updatedBy: input.userId,
    };
    sets[`prices.${update.itemKey}`] = entry;
  }
  if (input.bidder !== undefined) sets.bidder = input.bidder;

  const updated = await gaebPriceSheets.findOneAndUpdate(
    {
      tenantId: input.tenantId,
      documentId: input.documentId,
      sourceSha256: input.sourceSha256,
    },
    { $set: sets },
    { returnDocument: "after" },
  );
  if (!updated) return { ok: false, error: "gaeb_source_changed" };
  return { ok: true, sheet: updated };
}

/**
 * Re-pins the sheet to new source bytes, dropping every entry. Offered by the
 * UI when the underlying document version changed (restore, re-upload).
 */
export async function resetPriceSheet(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  sourceSha256: string;
  userId: string;
}): Promise<GaebPriceSheetDocument> {
  const { gaebPriceSheets } = await getAiCollections();
  const now = new Date();
  const updated = await gaebPriceSheets.findOneAndUpdate(
    { tenantId: input.tenantId, documentId: input.documentId },
    {
      $set: {
        sourceSha256: input.sourceSha256,
        prices: {},
        bidder: null,
        updatedAt: now,
      },
      $setOnInsert: {
        tenantId: input.tenantId,
        documentId: input.documentId,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  if (!updated) throw new Error("gaeb_price_sheet_reset_failed");
  return updated;
}

/** Working unit prices as the totals engine expects them. */
export function priceMap(sheet: GaebPriceSheetDocument | null): Map<string, number | null> {
  const map = new Map<string, number | null>();
  if (!sheet) return map;
  for (const [itemKey, entry] of Object.entries(sheet.prices)) {
    if (entry.decision === "rejected") continue;
    map.set(itemKey, entry.unitPrice);
  }
  return map;
}
