import { XMLBuilder, XMLParser } from "fast-xml-parser";

import { computeTotals, roundGaeb } from "../totals";
import type { GaebDocument, GaebPartyBlock } from "../types";
import { parseX8x } from "./parse-x8x";

/**
 * X84 writer: surgical mutation of the ORIGINAL bytes, never regeneration
 * from the canonical model. The source is parsed with preserveOrder so
 * everything the AVA software expects — element order, unknown extensions,
 * whitespace — survives; only the DP, the bidder block, per-item UP/IT and
 * the BoQ total change. `verifyX84` re-reads the output with the normal
 * reader and must pass BEFORE any byte is stored.
 */

/* ------------------------- preserveOrder utilities ------------------------ */

type OrderedNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: false,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  commentPropName: "#comment",
  cdataPropName: "#cdata",
});

// Entity handling mirrored with the parser: values went in undecoded, so the
// builder must not escape them again (double-escape trap).
const builder = new XMLBuilder({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  processEntities: false,
  suppressEmptyNode: false,
  format: false,
  commentPropName: "#comment",
  cdataPropName: "#cdata",
});

function tagOf(node: OrderedNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ":@") return key;
  }
  return null;
}

function localTag(node: OrderedNode): string {
  const tag = tagOf(node);
  if (!tag) return "";
  const index = tag.indexOf(":");
  return (index >= 0 ? tag.slice(index + 1) : tag).toLowerCase();
}

function childrenOf(node: OrderedNode): OrderedNode[] {
  const tag = tagOf(node);
  const value = tag ? node[tag] : null;
  return Array.isArray(value) ? (value as OrderedNode[]) : [];
}

function findChild(nodes: OrderedNode[], local: string): OrderedNode | undefined {
  return nodes.find((node) => localTag(node) === local);
}

function filterChildren(nodes: OrderedNode[], local: string): OrderedNode[] {
  return nodes.filter((node) => localTag(node) === local);
}

function makeElement(tag: string, text?: string): OrderedNode {
  return { [tag]: text === undefined ? [] : [{ "#text": text }] };
}

/** Replaces an element's content with a single text node. */
function setText(node: OrderedNode, value: string): void {
  const tag = tagOf(node);
  if (!tag) return;
  node[tag] = [{ "#text": value }];
}

function attrOf(node: OrderedNode, name: string): string | null {
  const attrs = node[":@"] as Record<string, unknown> | undefined;
  const value = attrs?.[`@${name}`];
  return value === undefined || value === null ? null : String(value);
}

/** Upserts child `tag` with `value`, inserting after the best anchor. */
function upsertText(
  parentChildren: OrderedNode[],
  tag: string,
  value: string,
  anchorsAfter: string[],
): void {
  const existing = findChild(parentChildren, tag.toLowerCase());
  if (existing) {
    setText(existing, value);
    return;
  }
  let insertAt = parentChildren.length;
  for (const anchor of anchorsAfter) {
    const index = parentChildren.findIndex((node) => localTag(node) === anchor);
    if (index >= 0) {
      insertAt = index + 1;
      break;
    }
  }
  parentChildren.splice(insertAt, 0, makeElement(tag, value));
}

/** GAEB money text: 2 decimals; a significant third decimal survives on UP. */
function formatMoney(value: number, maxDecimals: 2 | 3): string {
  const three = value.toFixed(3);
  if (maxDecimals === 3 && !three.endsWith("0")) return three;
  return value.toFixed(2);
}

/* -------------------------------- traversal ------------------------------- */

/**
 * Items in EXACTLY the reader's order (parse-x8x WalkState): per body, all
 * BoQCtgy subtrees first (inner body, then the category's own item lists),
 * then the body's own item lists. Ordinal alignment with the canonical model
 * follows by construction; per-item asserts catch any residue.
 */
function collectItems(bodyChildren: OrderedNode[]): OrderedNode[] {
  const out: OrderedNode[] = [];
  const walkBody = (children: OrderedNode[]): void => {
    for (const category of filterChildren(children, "boqctgy")) {
      const categoryChildren = childrenOf(category);
      const innerBody = findChild(categoryChildren, "boqbody");
      if (innerBody) walkBody(childrenOf(innerBody));
      for (const itemlist of filterChildren(categoryChildren, "itemlist")) {
        out.push(...filterChildren(childrenOf(itemlist), "item"));
      }
    }
    for (const itemlist of filterChildren(children, "itemlist")) {
      out.push(...filterChildren(childrenOf(itemlist), "item"));
    }
  };
  walkBody(bodyChildren);
  return out;
}

function sniffEncoding(buffer: Buffer): "latin1" | "utf16le" | "utf8" {
  const head = buffer.subarray(0, 200).toString("latin1");
  const match = /encoding=["']([^"']+)["']/i.exec(head);
  const encoding = match?.[1]?.toLowerCase() ?? "utf-8";
  if (["iso-8859-1", "latin1", "windows-1252"].includes(encoding)) return "latin1";
  if (["utf-16", "utf-16le"].includes(encoding)) return "utf16le";
  return "utf8";
}

/* --------------------------------- writer --------------------------------- */

export interface BuildX84Input {
  sourceBytes: Buffer;
  /** Canonical parse of the SAME bytes — item order authority. */
  source: GaebDocument;
  /** Working unit prices by item key. Only listed items are written. */
  prices: ReadonlyMap<string, number>;
  bidder: GaebPartyBlock | null;
}

export function buildX84(input: BuildX84Input): Buffer {
  const encoding = sniffEncoding(input.sourceBytes);
  const text = input.sourceBytes.toString(encoding);
  const tree = parser.parse(text) as OrderedNode[];

  const root = tree.find((node) => localTag(node) === "gaeb");
  if (!root) throw new Error("x84_writer_no_root");

  // The namespace names the exchange phase; an X84 payload must not claim DA83.
  const rootAttrs = root[":@"] as Record<string, unknown> | undefined;
  if (rootAttrs) {
    for (const [key, value] of Object.entries(rootAttrs)) {
      if (key.toLowerCase().startsWith("@xmlns") && typeof value === "string") {
        rootAttrs[key] = value.replace(/DA8[1-6]\//, "DA84/");
      }
    }
  }

  const rootChildren = childrenOf(root);
  const award = findChild(rootChildren, "award");
  if (!award) throw new Error("x84_writer_no_award");
  const awardChildren = childrenOf(award);

  upsertText(awardChildren, "DP", "84", []);
  const dp = findChild(awardChildren, "dp");
  if (dp) setText(dp, "84");

  if (input.bidder) writeBidder(awardChildren, input.bidder);

  const boq = findChild(awardChildren, "boq");
  if (!boq) throw new Error("x84_writer_no_boq");
  const boqChildren = childrenOf(boq);
  const body = findChild(boqChildren, "boqbody");
  if (!body) throw new Error("x84_writer_no_body");

  const itemNodes = collectItems(childrenOf(body));
  if (itemNodes.length !== input.source.items.length) {
    throw new Error(
      `x84_writer_item_count_mismatch:${itemNodes.length}!=${input.source.items.length}`,
    );
  }

  input.source.items.forEach((item, index) => {
    const node = itemNodes[index];
    // Ordinal alignment is asserted against the source facts, not trusted.
    const nodeRNoPart = attrOf(node, "RNoPart") ?? "";
    if (nodeRNoPart !== item.rNoPart) {
      throw new Error(`x84_writer_item_misaligned:${item.key}`);
    }
    const nodeId = attrOf(node, "ID");
    if (item.sourceId && nodeId && nodeId !== item.sourceId) {
      throw new Error(`x84_writer_item_id_mismatch:${item.key}`);
    }

    const unitPrice = input.prices.get(item.key);
    if (unitPrice === undefined || unitPrice === null) return;
    const nodeChildren = childrenOf(node);
    upsertText(nodeChildren, "UP", formatMoney(unitPrice, 3), [
      "description",
      "qu",
      "qty",
    ]);
    const qty = item.qty ?? (item.markers.includes("lump_sum") ? 1 : null);
    if (qty !== null) {
      upsertText(nodeChildren, "IT", formatMoney(roundGaeb(unitPrice * qty), 2), [
        "up",
        "description",
        "qu",
        "qty",
      ]);
    }
  });

  // Grand total (net). Category totals stay untouched — AVA software
  // recomputes them on import, and inventing nodes mid-tree risks order.
  const totals = computeTotals({
    items: input.source.items,
    prices: input.prices,
    vatRate: input.source.meta.vatRate,
    categories: input.source.categories,
  });
  const totalsNode = findChild(boqChildren, "totals");
  if (totalsNode) {
    const totalsChildren = childrenOf(totalsNode);
    upsertText(totalsChildren, "Total", formatMoney(totals.net, 2), []);
  } else {
    boqChildren.push({ Totals: [makeElement("Total", formatMoney(totals.net, 2))] });
  }

  const output = builder.build(tree) as string;
  return Buffer.from(output, encoding);
}

function writeBidder(awardChildren: OrderedNode[], bidder: GaebPartyBlock): void {
  let ctr = findChild(awardChildren, "ctr");
  if (!ctr) {
    ctr = { CTR: [{ Address: [] }] };
    // After OWN when present, else after AwardInfo, else after DP.
    let insertAt = awardChildren.length;
    for (const anchor of ["own", "awardinfo", "dp"]) {
      const index = awardChildren.findIndex((node) => localTag(node) === anchor);
      if (index >= 0) {
        insertAt = index + 1;
        break;
      }
    }
    awardChildren.splice(insertAt, 0, ctr);
  }
  const ctrChildren = childrenOf(ctr);
  let address = findChild(ctrChildren, "address");
  if (!address) {
    address = { Address: [] };
    ctrChildren.unshift(address);
  }
  const addressChildren = childrenOf(address);
  const slots: Array<[string, string | null, string[]]> = [
    ["Name1", bidder.name, []],
    ["Street", bidder.street, ["name4", "name3", "name2", "name1"]],
    ["PCode", bidder.zip, ["street"]],
    ["City", bidder.city, ["pcode"]],
    ["Contact", bidder.contact, ["city"]],
    ["Email", bidder.email, ["contact", "city"]],
  ];
  for (const [tag, value, anchors] of slots) {
    if (value) upsertText(addressChildren, tag, value, anchors);
  }
}

/* --------------------------------- verify --------------------------------- */

export interface VerifyX84Input {
  source: GaebDocument;
  prices: ReadonlyMap<string, number>;
}

export function verifyX84(
  output: Buffer,
  expected: VerifyX84Input,
): { ok: true } | { ok: false; failures: string[] } {
  const failures: string[] = [];
  const reparsed = parseX8x(output, "x84");
  if (!reparsed.ok) {
    return { ok: false, failures: [`reparse_failed:${reparsed.error.code}`] };
  }
  const document = reparsed.document;

  if (document.phase !== 84) failures.push(`phase:${document.phase}`);
  if (document.items.length !== expected.source.items.length) {
    failures.push(`item_count:${document.items.length}!=${expected.source.items.length}`);
  }

  const expectedTotals = computeTotals({
    items: expected.source.items,
    prices: expected.prices,
    vatRate: expected.source.meta.vatRate,
    categories: expected.source.categories,
  });

  const count = Math.min(document.items.length, expected.source.items.length);
  for (let index = 0; index < count; index++) {
    const written = document.items[index];
    const original = expected.source.items[index];
    if (written.oz !== original.oz) {
      failures.push(`oz:${original.key}`);
      continue;
    }
    if ((written.qty ?? null) !== (original.qty ?? null)) failures.push(`qty:${original.key}`);
    if (written.shortText !== original.shortText) failures.push(`text:${original.key}`);

    const price = expected.prices.get(original.key);
    if (price === undefined || price === null) continue;
    if (written.existingUnitPrice === null || Math.abs(written.existingUnitPrice - price) > 0.0005) {
      failures.push(`up:${original.key}`);
    }
    const expectedLine = expectedTotals.byItem.get(original.key)?.total ?? null;
    if (expectedLine !== null) {
      if (written.existingTotal === null || Math.abs(written.existingTotal - expectedLine) > 0.005) {
        failures.push(`it:${original.key}`);
      }
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures: failures.slice(0, 25) };
}
