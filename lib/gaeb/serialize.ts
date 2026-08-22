import type { GaebPriceSheetDocument } from "./price-sheet";
import type { GaebStoredDocument } from "./store";
import type { GaebTotals } from "./totals";
import type { GaebDocument, GaebItem } from "./types";

/**
 * Client views. The list payload keeps items compact (a 535-position LV ships
 * hundreds of KB of Langtext otherwise); the full description is served per
 * item on demand.
 */

const LONG_TEXT_PREVIEW_CHARS = 200;

export interface GaebClientItem {
  key: string;
  oz: string;
  categoryKey: string;
  shortText: string;
  longTextPreview: string | null;
  hasLongText: boolean;
  qty: number | null;
  qtyUnit: string | null;
  existingUnitPrice: number | null;
  markers: GaebItem["markers"];
  notInTotal: boolean;
}

export function serializeGaebItem(item: GaebItem): GaebClientItem {
  return {
    key: item.key,
    oz: item.oz,
    categoryKey: item.categoryKey,
    shortText: item.shortText,
    longTextPreview: item.longText ? item.longText.slice(0, LONG_TEXT_PREVIEW_CHARS) : null,
    hasLongText: Boolean(item.longText),
    qty: item.qty,
    qtyUnit: item.qtyUnit,
    existingUnitPrice: item.existingUnitPrice,
    markers: item.markers,
    notInTotal: item.notInTotal,
  };
}

export function serializeGaebDocument(stored: GaebStoredDocument) {
  const document = stored.document;
  return {
    parserVersion: stored.parserVersion,
    sourceSha256: stored.sourceSha256,
    parsedAt: stored.parsedAt.toISOString(),
    parseError: stored.parseError,
    document: document ? serializeParsed(document) : null,
  };
}

function serializeParsed(document: GaebDocument) {
  return {
    flavor: document.flavor,
    phase: document.phase,
    schemaVersion: document.schemaVersion,
    meta: document.meta,
    ozMask: document.ozMask,
    preliminaryText: document.preliminaryText,
    preliminaryTextTruncated: document.preliminaryTextTruncated,
    categories: document.categories,
    items: document.items.map(serializeGaebItem),
    stats: document.stats,
  };
}

export function serializePriceSheet(sheet: GaebPriceSheetDocument | null) {
  if (!sheet) return null;
  return {
    sourceSha256: sheet.sourceSha256,
    bidder: sheet.bidder,
    prices: Object.fromEntries(
      Object.entries(sheet.prices).map(([itemKey, entry]) => [
        itemKey,
        {
          unitPrice: entry.unitPrice,
          decision: entry.decision,
          suggestionRunId: entry.suggestionRunId,
          note: entry.note,
          updatedAt: entry.updatedAt.toISOString(),
        },
      ]),
    ),
    updatedAt: sheet.updatedAt.toISOString(),
  };
}

export function serializeTotals(totals: GaebTotals) {
  return {
    byItem: Object.fromEntries(
      Array.from(totals.byItem.entries(), ([key, value]) => [key, value.total]),
    ),
    byCategory: Object.fromEntries(totals.byCategory.entries()),
    net: totals.net,
    vat: totals.vat,
    gross: totals.gross,
    unpricedCount: totals.unpricedCount,
    excludedKeys: totals.excludedKeys,
  };
}
