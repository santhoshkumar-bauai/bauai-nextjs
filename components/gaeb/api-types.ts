import type {
  GaebCategory,
  GaebItemMarker,
  GaebOzMask,
  GaebParseError,
  GaebPartyBlock,
  GaebProjectMeta,
} from "@/lib/gaeb/types";

/** JSON contracts of the /api/workspace-documents/[id]/gaeb routes. */

export interface GaebApiItem {
  key: string;
  oz: string;
  categoryKey: string;
  shortText: string;
  longTextPreview: string | null;
  hasLongText: boolean;
  qty: number | null;
  qtyUnit: string | null;
  existingUnitPrice: number | null;
  markers: GaebItemMarker[];
  notInTotal: boolean;
}

export interface GaebApiParsed {
  flavor: "xml" | "gaeb90" | "gaeb2000";
  phase: number;
  schemaVersion: string | null;
  meta: GaebProjectMeta;
  ozMask: GaebOzMask | null;
  preliminaryText: string | null;
  preliminaryTextTruncated: boolean;
  categories: GaebCategory[];
  items: GaebApiItem[];
  stats: { itemCount: number; categoryCount: number; hasExistingPrices: boolean };
}

export interface GaebApiPriceEntry {
  unitPrice: number | null;
  decision: "accepted" | "edited" | "rejected" | "manual" | null;
  suggestionRunId: string | null;
  note: string | null;
  updatedAt: string;
}

export interface GaebApiTotals {
  byItem: Record<string, number | null>;
  byCategory: Record<string, { net: number; itemCount: number; pricedCount: number }>;
  net: number;
  vat: number;
  gross: number;
  unpricedCount: number;
  excludedKeys: string[];
}

export interface GaebApiFillItem {
  itemKey: string;
  oz: string;
  batchIndex: number;
  status: "pending" | "classified" | "priced" | "failed" | "skipped";
  classification: {
    trade: string;
    workCategory: string;
    attributes: string[];
    productMentions: string[];
  } | null;
  suggestion: {
    unitPrice: number;
    rangeLow: number;
    rangeHigh: number;
    confidence: number;
    assumptions: string[];
    risks: string[];
    evidence: Array<{ source: string; reference: string; excerpt: string }>;
    reason: string;
  } | null;
  error: string | null;
  updatedAt: string;
}

export interface GaebApiFillRun {
  id: string;
  documentId: string;
  format: string;
  sourceStorageRevision: number;
  status:
    | "queued"
    | "analyzing"
    | "review"
    | "generating"
    | "completed"
    | "failed"
    | "cancelled";
  stage: string;
  gaeb?: {
    phase: number;
    flavor: string;
    parserVersion: string;
    sourceItemCount: number;
    batchSize: number;
    batchCount: number;
    classifiedCount: number;
    pricedCount: number;
    failedCount: number;
    skippedCount: number;
    webLookupsDone: number;
    webLookupsTotal: number;
    warnings: string[];
  } | null;
  generatedDocumentId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface GaebViewResponse {
  source: {
    fileName: string;
    extension: string;
    sha256: string;
    storageRevision: number;
    size: number;
  };
  gaeb: {
    parserVersion: string;
    sourceSha256: string;
    parsedAt: string;
    parseError: GaebParseError | null;
    document: GaebApiParsed | null;
  };
  priceSheet: {
    sourceSha256: string;
    bidder: GaebPartyBlock | null;
    prices: Record<string, GaebApiPriceEntry>;
    updatedAt: string;
  } | null;
  priceSheetStale: boolean;
  totals: GaebApiTotals | null;
  fillRun: GaebApiFillRun | null;
}

export interface GaebFillResponse {
  run: GaebApiFillRun | null;
  items: GaebApiFillItem[];
  counts: Record<GaebApiFillItem["status"], number> | null;
}

export interface GaebItemDetailResponse {
  item: {
    key: string;
    oz: string;
    shortText: string;
    longText: string | null;
    longTextTruncated: boolean;
    qty: number | null;
    qtyUnit: string | null;
    existingUnitPrice: number | null;
    existingTotal: number | null;
    markers: GaebItemMarker[];
    alternative: { groupNo: string | null; seriesNo: string | null } | null;
    notInTotal: boolean;
    categoryPath: Array<{ oz: string; label: string }>;
  };
  fillItem: GaebApiFillItem | null;
}
