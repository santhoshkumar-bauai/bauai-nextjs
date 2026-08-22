import type { GaebFlavor, GaebPhase } from "./format";

export type { GaebExtension, GaebFlavor, GaebPhase } from "./format";

/**
 * Canonical parsed bill of quantities. Layer A of the GAEB data model: an
 * immutable projection of the source bytes. Prices typed by the user or
 * proposed by Dora never live here — they belong to the price sheet and the
 * fill run respectively.
 */
export interface GaebDocument {
  flavor: GaebFlavor;
  phase: GaebPhase;
  /** GAEBInfo/Version, e.g. "3.2". Null for non-XML flavors. */
  schemaVersion: string | null;
  /** Encoding actually used to decode the source bytes. */
  sourceEncoding: string;
  meta: GaebProjectMeta;
  /** BoQInfo/BoQBkdn breakdown definition; null when the file omits it. */
  ozMask: GaebOzMask | null;
  /** Vorbemerkungen / remark blocks, flattened to plain text. Capped. */
  preliminaryText: string | null;
  preliminaryTextTruncated: boolean;
  /** BoQCtgy tree in document order (parents before children). */
  categories: GaebCategory[];
  /** FLAT list in document order — the single source of truth for positions. */
  items: GaebItem[];
  stats: GaebDocumentStats;
}

export interface GaebDocumentStats {
  itemCount: number;
  categoryCount: number;
  /** Any UP/IT present in the source (X82/X84 re-imports). */
  hasExistingPrices: boolean;
}

export interface GaebProjectMeta {
  projectName: string | null;
  boqName: string | null;
  awardNumber: string | null;
  /** ISO 4217 where the file provides it; display defaults to EUR downstream. */
  currency: string | null;
  /** Percent, e.g. 19. Null when the file does not state a rate. */
  vatRate: number | null;
  buyer: GaebPartyBlock | null;
  /** Present on X84/X85 sources; the block the X84 writer fills for exports. */
  bidder: GaebPartyBlock | null;
  /** ISO date string when present. */
  offerDeadline: string | null;
}

export interface GaebPartyBlock {
  name: string | null;
  street: string | null;
  zip: string | null;
  city: string | null;
  contact: string | null;
  email: string | null;
}

export interface GaebOzMaskPart {
  kind: "category" | "item" | "index";
  length: number;
  /** Whether the part is numeric and therefore zero-padded to `length`. */
  numeric: boolean;
  label: string | null;
}

export interface GaebOzMask {
  parts: GaebOzMaskPart[];
}

export interface GaebCategory {
  /** Stable ordinal key ("c-0001"); Mongo-safe unlike OZ, which contains dots. */
  key: string;
  parentKey: string | null;
  /** Raw RNoPart as written in the source. */
  rNoPart: string;
  /** Composed hierarchical number per the OZ mask, e.g. "01.02". */
  oz: string;
  label: string;
  depth: number;
  childKeys: string[];
  itemKeys: string[];
}

export type GaebItemMarker =
  | "provisional" /* Bedarfsposition */
  | "alternative" /* Alternativposition */
  | "lump_sum" /* Pauschale */
  | "hourly" /* Stundenlohnarbeiten */
  | "surcharge" /* Zulage */
  | "free_quantity"; /* Freie Menge */

export interface GaebItem {
  /** Stable ordinal key ("i-0001") — the identity used by the price sheet,
   * the fill items, and the UI. Deterministic for identical bytes and
   * parser version. */
  key: string;
  /** Position in source traversal order; the X84 writer asserts alignment. */
  sourceIndex: number;
  /** Source element ID attribute when present. */
  sourceId: string | null;
  rNoPart: string;
  /** Full composed OZ, e.g. "01.02.0010". Display-only — never identity. */
  oz: string;
  categoryKey: string;
  shortText: string;
  longText: string | null;
  longTextTruncated: boolean;
  qty: number | null;
  /** Unit verbatim from the source ("m2", "St", "psch", "lfdm"). */
  qtyUnit: string | null;
  /** UP already present in the source — reference only, never a working price. */
  existingUnitPrice: number | null;
  existingTotal: number | null;
  markers: GaebItemMarker[];
  alternative: { groupNo: string | null; seriesNo: string | null } | null;
  /** Excluded from category/grand totals (Bedarf without GB, alternatives). */
  notInTotal: boolean;
}

export type GaebParseErrorCode =
  | "unsupported_flavor"
  | "invalid_xml"
  | "unrecognized_structure"
  | "encoding_error"
  | "too_large"
  | "empty_boq";

export interface GaebParseError {
  code: GaebParseErrorCode;
  message: string;
}

export type GaebParseResult =
  | { ok: true; document: GaebDocument }
  | { ok: false; error: GaebParseError };
