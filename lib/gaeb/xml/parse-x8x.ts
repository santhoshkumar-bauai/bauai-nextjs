import {
  attribute,
  child,
  children,
  collectDescendants,
  documentElement,
  parseXml,
  path,
  textAt,
} from "@/lib/ingestion/eforms/xml";

import { gaebPhase, type GaebExtension, type GaebPhase } from "../format";
import { composeOz } from "../oz";
import { capText, flattenRichText } from "../text";
import type {
  GaebCategory,
  GaebDocument,
  GaebItem,
  GaebItemMarker,
  GaebOzMask,
  GaebOzMaskPart,
  GaebParseResult,
  GaebPartyBlock,
} from "../types";

/**
 * Reader for GAEB DA XML 3.x (.x81–.x86).
 *
 * Namespace-agnostic on purpose: the GAEB namespace URI changes per phase and
 * schema version (DA83/3.2, DA84/3.3, …) while the local structure is stable.
 * Tolerant on purpose: real-world files come from a dozen AVA systems with
 * uneven schema discipline, and a missing optional block must degrade the
 * canonical model, not fail the file.
 */

const LONG_TEXT_MAX_CHARS = 8_000;
const SHORT_TEXT_MAX_CHARS = 300;
const PRELIMINARY_MAX_CHARS = 64_000;

/** Units that mark hourly-work positions. Heuristic — GAEB DA XML has no
 * dedicated hourly flag, but Stundenlohnarbeiten are always priced per hour. */
const HOURLY_UNITS = new Set(["h", "std", "std.", "stunde", "stunden", "hour", "hours"]);

export function parseX8x(buffer: Buffer, extension: GaebExtension): GaebParseResult {
  let parsed: ReturnType<typeof parseXml>;
  try {
    parsed = parseXml(buffer, `gaeb:${extension}`);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "invalid_xml",
        message: error instanceof Error ? error.message.slice(0, 300) : "unparseable XML",
      },
    };
  }

  const root = documentElement(parsed);
  if (!root || root.name.toUpperCase() !== "GAEB") {
    return {
      ok: false,
      error: {
        code: "unrecognized_structure",
        message: `document element is ${root ? root.name : "missing"}, expected GAEB`,
      },
    };
  }

  try {
    return buildDocument(buffer, extension, root.node);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "unrecognized_structure",
        message: error instanceof Error ? error.message.slice(0, 300) : "unrecognized GAEB structure",
      },
    };
  }
}

function buildDocument(
  buffer: Buffer,
  extension: GaebExtension,
  root: Record<string, unknown>,
): GaebParseResult {
  const award = child(root, "Award");
  const boq = child(award, "BoQ") ?? collectDescendants(root, "BoQ")[0];
  if (!boq) {
    return {
      ok: false,
      error: { code: "empty_boq", message: "no BoQ element in file" },
    };
  }

  const awardInfo = child(award, "AwardInfo");
  const prjInfo = child(root, "PrjInfo");
  const boqInfo = child(boq, "BoQInfo");
  const mask = parseOzMask(boqInfo);

  const state = new WalkState(mask);
  state.walkBody(child(boq, "BoQBody"), null, []);
  collectAwardTexts(award, state);

  if (state.items.length === 0) {
    return {
      ok: false,
      error: { code: "empty_boq", message: "BoQ contains no positions" },
    };
  }

  const preliminary = capText(state.preliminaryParts.join("\n\n"), PRELIMINARY_MAX_CHARS);
  const phase = resolvePhase(award, extension);

  const document: GaebDocument = {
    flavor: "xml",
    phase,
    schemaVersion: textAt(root, "GAEBInfo", "Version"),
    sourceEncoding: sniffEncoding(buffer),
    meta: {
      projectName: textAt(prjInfo, "Name") ?? textAt(prjInfo, "LblPrj"),
      boqName: textAt(boqInfo, "Name") ?? flattenNullable(child(boqInfo, "LblBoQ")),
      awardNumber: textAt(awardInfo, "AwardNo") ?? textAt(prjInfo, "AwardNo"),
      currency: normalizeCurrency(textAt(awardInfo, "Cur") ?? textAt(prjInfo, "Cur")),
      vatRate: parseDecimal(textAt(awardInfo, "VAT") ?? textAt(boqInfo, "VAT")),
      buyer: parseParty(child(award, "OWN")),
      bidder: parseParty(child(award, "CTR")),
      offerDeadline: parseDate(textAt(awardInfo, "SubmDate") ?? textAt(awardInfo, "OpenDate")),
    },
    ozMask: mask,
    preliminaryText: preliminary.text || null,
    preliminaryTextTruncated: preliminary.truncated,
    categories: state.categories,
    items: state.items,
    stats: {
      itemCount: state.items.length,
      categoryCount: state.categories.length,
      hasExistingPrices: state.items.some(
        (item) => item.existingUnitPrice !== null || item.existingTotal !== null,
      ),
    },
  };

  return { ok: true, document };
}

/* -------------------------------------------------------------------------- */
/* Tree walk                                                                  */
/* -------------------------------------------------------------------------- */

class WalkState {
  readonly categories: GaebCategory[] = [];
  readonly items: GaebItem[] = [];
  readonly preliminaryParts: string[] = [];
  private syntheticRoot: GaebCategory | null = null;

  constructor(private readonly mask: GaebOzMask | null) {}

  walkBody(body: unknown, parent: GaebCategory | null, chain: string[]): void {
    if (!body) return;

    for (const remark of children(body, "Remark")) this.collectRemark(remark);

    for (const node of children(body, "BoQCtgy")) {
      const rNoPart = attribute(node, "RNoPart") ?? "";
      const nextChain = [...chain, rNoPart];
      const category: GaebCategory = {
        key: `c-${String(this.categories.length + 1).padStart(4, "0")}`,
        parentKey: parent?.key ?? null,
        rNoPart,
        oz: composeOz({ mask: this.mask, categoryParts: nextChain }),
        label: flattenRichText(child(node, "LblTx")) || composeOz({ mask: this.mask, categoryParts: nextChain }),
        depth: chain.length,
        childKeys: [],
        itemKeys: [],
      };
      this.categories.push(category);
      parent?.childKeys.push(category.key);

      this.walkBody(child(node, "BoQBody"), category, nextChain);
      // Schema also allows Itemlist directly under BoQCtgy.
      for (const itemlist of children(node, "Itemlist")) {
        this.walkItemlist(itemlist, category, nextChain);
      }
    }

    for (const itemlist of children(body, "Itemlist")) {
      this.walkItemlist(itemlist, parent ?? this.ensureSyntheticRoot(), chain);
    }
  }

  private walkItemlist(itemlist: unknown, category: GaebCategory, chain: string[]): void {
    for (const remark of children(itemlist, "Remark")) this.collectRemark(remark);

    for (const node of children(itemlist, "Item")) {
      const item = this.buildItem(node, category, chain);
      this.items.push(item);
      category.itemKeys.push(item.key);
    }
  }

  private buildItem(node: unknown, category: GaebCategory, chain: string[]): GaebItem {
    const sourceIndex = this.items.length;
    const rNoPart = attribute(node, "RNoPart") ?? "";
    const oz = composeOz({
      mask: this.mask,
      categoryParts: chain,
      itemPart: rNoPart,
      indexPart: attribute(node, "RNoIndex"),
    });

    const description = child(node, "Description");
    const complete = child(description, "CompleteText") ?? description;
    const outline =
      path(complete, "OutlineText", "OutlTxt") ??
      child(complete, "OutlineText") ??
      child(description, "OutlineText");
    const detail = child(complete, "DetailTxt") ?? child(description, "DetailTxt");

    const long = capText(flattenRichText(detail), LONG_TEXT_MAX_CHARS);
    const shortRaw = flattenRichText(outline).replace(/\n+/g, " ").trim();
    const shortFallback = long.text.split("\n").find((line) => line.trim().length > 0) ?? "";
    const shortText =
      capText(shortRaw || shortFallback, SHORT_TEXT_MAX_CHARS).text || `Position ${oz || sourceIndex + 1}`;

    const qtyUnit = textAt(node, "QU");
    const markers = detectMarkers(node, qtyUnit);
    const alternative = parseAlternative(node);

    return {
      key: `i-${String(sourceIndex + 1).padStart(4, "0")}`,
      sourceIndex,
      sourceId: attribute(node, "ID"),
      rNoPart,
      oz,
      categoryKey: category.key,
      shortText,
      longText: long.text || null,
      longTextTruncated: long.truncated,
      qty: parseDecimal(textAt(node, "Qty")),
      qtyUnit,
      existingUnitPrice: parseDecimal(textAt(node, "UP")),
      existingTotal: parseDecimal(textAt(node, "IT")),
      markers,
      alternative,
      notInTotal: isExcludedFromTotal(node, markers, alternative),
    };
  }

  private collectRemark(remark: unknown): void {
    const text = flattenRichText(
      child(remark, "Description") ?? child(remark, "DetailTxt") ?? remark,
    );
    if (text) this.preliminaryParts.push(text);
  }

  private ensureSyntheticRoot(): GaebCategory {
    if (!this.syntheticRoot) {
      this.syntheticRoot = {
        key: `c-${String(this.categories.length + 1).padStart(4, "0")}`,
        parentKey: null,
        rNoPart: "",
        oz: "",
        label: "",
        depth: 0,
        childKeys: [],
        itemKeys: [],
      };
      this.categories.push(this.syntheticRoot);
    }
    return this.syntheticRoot;
  }
}

/* -------------------------------------------------------------------------- */
/* Field helpers                                                              */
/* -------------------------------------------------------------------------- */

function detectMarkers(node: unknown, qtyUnit: string | null): GaebItemMarker[] {
  const markers: GaebItemMarker[] = [];
  if (child(node, "Provis") !== undefined) markers.push("provisional");
  if (textAt(node, "ALNGroupNo")) markers.push("alternative");
  if (isYes(textAt(node, "LumpSumItem"))) markers.push("lump_sum");
  if (child(node, "MarkupItem") !== undefined || isYes(textAt(node, "Markup"))) {
    markers.push("surcharge");
  }
  if (child(node, "QtyTBD") !== undefined || isYes(textAt(node, "FreeQty"))) {
    markers.push("free_quantity");
  }
  if (qtyUnit && HOURLY_UNITS.has(qtyUnit.trim().toLowerCase())) markers.push("hourly");
  return markers;
}

function parseAlternative(node: unknown): GaebItem["alternative"] {
  const groupNo = textAt(node, "ALNGroupNo");
  const seriesNo = textAt(node, "ALNSerNo");
  if (!groupNo && !seriesNo) return null;
  return { groupNo, seriesNo };
}

/**
 * Bedarfspositionen "ohne GB" and true alternatives do not count toward the
 * bid total. A Provis explicitly marked WithTotal keeps counting; an ALN
 * base position (series 0 or absent) keeps counting.
 */
function isExcludedFromTotal(
  node: unknown,
  markers: GaebItemMarker[],
  alternative: GaebItem["alternative"],
): boolean {
  if (markers.includes("provisional")) {
    const provis = child(node, "Provis");
    const type = attribute(provis, "Type") ?? textAt(node, "Provis");
    if (!type || !/withtotal|mit\s*gb/i.test(type)) return true;
  }
  if (markers.includes("alternative")) {
    const series = Number.parseInt(alternative?.seriesNo ?? "", 10);
    if (Number.isFinite(series) && series > 0) return true;
  }
  return false;
}

function parseOzMask(boqInfo: unknown): GaebOzMask | null {
  const parts: GaebOzMaskPart[] = [];
  for (const node of children(boqInfo, "BoQBkdn")) {
    const typeRaw = (textAt(node, "Type") ?? "").toLowerCase();
    const kind: GaebOzMaskPart["kind"] | null = /boqlevel|ctgylevel|lot|title/.test(typeRaw)
      ? "category"
      : /item|position/.test(typeRaw)
        ? "item"
        : /index/.test(typeRaw)
          ? "index"
          : null;
    if (!kind) continue;
    const length = parseDecimal(textAt(node, "Length"));
    parts.push({
      kind,
      length: length && length > 0 && length <= 14 ? Math.floor(length) : 2,
      numeric: isYes(textAt(node, "Num")),
      label: textAt(node, "LblBoQBkdn"),
    });
  }
  return parts.length > 0 ? { parts } : null;
}

function collectAwardTexts(award: unknown, state: WalkState): void {
  for (const addText of children(award, "AddText")) {
    const text = flattenRichText(addText);
    if (text) state.preliminaryParts.push(text);
  }
}

function parseParty(node: unknown): GaebPartyBlock | null {
  if (!node) return null;
  const address = child(node, "Address") ?? node;
  const name = [textAt(address, "Name1"), textAt(address, "Name2"), textAt(address, "Name3")]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .trim();
  const party: GaebPartyBlock = {
    name: name || null,
    street: textAt(address, "Street"),
    zip: textAt(address, "PCode"),
    city: textAt(address, "City"),
    contact: textAt(address, "Contact") ?? flattenNullable(child(address, "Contact")),
    email: textAt(address, "Email"),
  };
  return Object.values(party).some((value) => value !== null) ? party : null;
}

function resolvePhase(award: unknown, extension: GaebExtension): GaebPhase {
  const declared = Number.parseInt(textAt(award, "DP") ?? "", 10);
  if (declared >= 81 && declared <= 86) return declared as GaebPhase;
  return gaebPhase(extension);
}

function parseDecimal(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: string | null): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(value.trim()) ? value.trim() : null;
}

function normalizeCurrency(value: string | null): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

function isYes(value: string | null): boolean {
  return value !== null && /^(yes|ja|true|1)$/i.test(value.trim());
}

function flattenNullable(node: unknown): string | null {
  const text = flattenRichText(node);
  return text || null;
}

function sniffEncoding(buffer: Buffer): string {
  const head = buffer.subarray(0, 200).toString("latin1");
  const match = /encoding=["']([^"']+)["']/i.exec(head);
  return match?.[1]?.toLowerCase() ?? "utf-8";
}
