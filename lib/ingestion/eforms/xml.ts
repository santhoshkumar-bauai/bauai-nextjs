import { XMLParser } from "fast-xml-parser";

import { malformedPayload } from "../http/errors.ts";

/**
 * Hardened XML reader for official notices.
 *
 * Section 16 requires external entities to be disabled. `fast-xml-parser` never
 * resolves external entities or DTDs, and `processEntities: false` additionally
 * stops entity substitution inside attribute and text values, which closes the
 * billion-laughs style expansion path. Namespace prefixes are kept so `cbc:ID`
 * and `efbc:ID` stay distinguishable.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: false,
  processEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

export type XmlNode = Record<string, unknown>;

/**
 * The five predefined XML entities plus numeric character references.
 *
 * `processEntities: false` above is a security setting — it stops entity expansion
 * attacks — but it also leaves `&amp;` undecoded in ordinary text. That silently
 * corrupts every document URL carrying a query string
 * (`...Servlet?function=Detail&amp;TWOID=...` is not a fetchable URL) and any title
 * containing an ampersand.
 *
 * Decoding is done here instead: only the predefined entities and numeric references,
 * which are plain characters. Entities declared in a DTD are deliberately still left
 * alone, so nothing external is ever resolved.
 */
const XML_ENTITY = /&(?:#x([0-9a-fA-F]+)|#(\d+)|(amp|lt|gt|quot|apos));/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(value: string): string {
  if (!value.includes("&")) return value;

  // A single pass, so `&amp;lt;` decodes to the literal `&lt;` rather than to `<`.
  return value.replace(XML_ENTITY, (match, hex, dec, name) => {
    if (hex) return safeCodePoint(Number.parseInt(hex, 16), match);
    if (dec) return safeCodePoint(Number.parseInt(dec, 10), match);
    return NAMED_ENTITIES[name as string] ?? match;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function parseXml(body: Buffer, context: string): XmlNode {
  const text = decode(body);
  try {
    const parsed = parser.parse(text) as XmlNode;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("parser returned no document element");
    }
    return parsed;
  } catch (error) {
    throw malformedPayload(`Unparseable XML for ${context}`, error);
  }
}

/** Honours the XML declaration's encoding for the encodings sources actually use. */
function decode(body: Buffer): string {
  const head = body.subarray(0, 200).toString("latin1");
  const match = /encoding=["']([^"']+)["']/i.exec(head);
  const encoding = match?.[1]?.toLowerCase();

  if (encoding && encoding !== "utf-8" && encoding !== "utf8") {
    if (encoding === "iso-8859-1" || encoding === "latin1" || encoding === "windows-1252") {
      return body.toString("latin1");
    }
    if (encoding === "utf-16" || encoding === "utf-16le") {
      return body.toString("utf16le");
    }
  }
  return body.toString("utf8");
}

function stripPrefix(name: string): string {
  const index = name.indexOf(":");
  return index >= 0 ? name.slice(index + 1) : name;
}

/* -------------------------------------------------------------------------- */
/* Traversal helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Every element matching `localName`, flattened.
 *
 * The parser represents a single occurrence as an object and a repeated one as an
 * array, so callers that can receive either — multilingual `cbc:Name`, lots,
 * locations — must go through this rather than indexing the raw value.
 * Namespace prefixes vary between sources, so lookups ignore the prefix.
 */
export function children(node: unknown, localName: string): unknown[] {
  if (!node || typeof node !== "object") return [];

  if (Array.isArray(node)) {
    return node.flatMap((entry) => children(entry, localName));
  }

  const record = node as XmlNode;
  for (const key of Object.keys(record)) {
    if (key.startsWith("@")) continue;
    if (stripPrefix(key) === localName) return asArray(record[key]);
  }
  return [];
}

/** First element matching `localName`, or undefined. */
export function child(node: unknown, localName: string): unknown {
  return children(node, localName)[0];
}

/** Walks a chain of local names, following the first match at each level. */
export function path(node: unknown, ...localNames: string[]): unknown {
  let current: unknown = node;
  for (const name of localNames) {
    current = child(current, name);
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current)) current = current[0];
  }
  return current;
}

export function asArray<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

/** Text content of an element, whether it has attributes or not. */
export function text(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === "string") return decodeXmlEntities(node.trim()) || null;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === "object") {
    const value = (node as XmlNode)["#text"];
    return value === undefined ? null : text(value);
  }
  return null;
}

export function attribute(node: unknown, name: string): string | null {
  if (!node || typeof node !== "object") return null;
  const target = Array.isArray(node) ? node[0] : node;
  if (!target || typeof target !== "object") return null;
  const value = (target as XmlNode)[`@${name}`];
  if (value === undefined || value === null) return null;
  return decodeXmlEntities(String(value).trim()) || null;
}

export function textAt(node: unknown, ...localNames: string[]): string | null {
  return text(path(node, ...localNames));
}

/**
 * Picks the element whose `listName` attribute matches, which is how eForms
 * distinguishes co-located codes such as `cpv` from `nuts`.
 */
export function findByListName(nodes: unknown, listName: string): unknown {
  for (const node of asArray(nodes)) {
    if (attribute(node, "listName") === listName) return node;
  }
  return undefined;
}

export function findBySchemeName(nodes: unknown, schemeName: string): unknown {
  for (const node of asArray(nodes)) {
    if (attribute(node, "schemeName") === schemeName) return node;
  }
  return undefined;
}

/**
 * Collects every descendant with the given local name. eForms nests extension
 * content several levels deep and the depth varies by SDK version, so an
 * exhaustive search is more durable than a hard-coded path.
 */
export function collectDescendants(node: unknown, localName: string): unknown[] {
  const found: unknown[] = [];
  const stack: unknown[] = [node];

  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    for (const [key, value] of Object.entries(current as XmlNode)) {
      if (key.startsWith("@") || key === "#text") continue;
      if (stripPrefix(key) === localName) found.push(...asArray(value));
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return found;
}

/** The document element, skipping the XML declaration node. */
export function documentElement(document: XmlNode): { name: string; node: XmlNode } | null {
  for (const [key, value] of Object.entries(document)) {
    if (key === "?xml" || key.startsWith("@")) continue;
    if (value && typeof value === "object") {
      return { name: stripPrefix(key), node: value as XmlNode };
    }
  }
  return null;
}
