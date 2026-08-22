/**
 * Flattening for GAEB rich-text blocks (DetailTxt/OutlineText/LblTx).
 *
 * GAEB DA XML wraps human text in a small XHTML-like dialect (`Text`, `div`,
 * `p`, `span`, `br`, plus TextComplement placeholders). The canonical model
 * keeps plain text only; the export writer re-reads the original bytes, so
 * nothing is lost by flattening here.
 */

type XmlValue = unknown;

/** Element names whose end marks a paragraph break in the flattened text. */
const BLOCK_NAMES = new Set(["p", "div", "text", "textoutltxt", "li", "tr"]);

function localName(key: string): string {
  const index = key.indexOf(":");
  return (index >= 0 ? key.slice(index + 1) : key).toLowerCase();
}

/**
 * Collects every text leaf under `node` in traversal order, inserting line
 * breaks after block-level elements. fast-xml-parser (non-preserveOrder mode)
 * loses interleaving between *different* sibling tags, but GAEB writers emit
 * span-only paragraphs, so paragraph-internal order survives via the span
 * arrays.
 */
export function flattenRichText(node: XmlValue): string {
  const out: string[] = [];
  walk(node, out);
  return normalizeWhitespace(out.join(""));
}

function walk(node: XmlValue, out: string[]): void {
  if (node === undefined || node === null) return;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    out.push(String(node));
    return;
  }
  if (Array.isArray(node)) {
    for (const entry of node) walk(entry, out);
    return;
  }
  if (typeof node !== "object") return;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.startsWith("@")) continue;
    if (key === "#text") {
      walk(value, out);
      continue;
    }
    const name = localName(key);
    if (name === "br") {
      out.push("\n");
      continue;
    }
    walk(value, out);
    if (BLOCK_NAMES.has(name)) out.push("\n");
  }
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Caps text at `max` characters on a whitespace boundary where possible. */
export function capText(
  text: string,
  max: number,
): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const slice = text.slice(0, max);
  const lastBreak = slice.lastIndexOf("\n");
  const cut = lastBreak > max * 0.6 ? lastBreak : max;
  return { text: slice.slice(0, cut).trimEnd(), truncated: true };
}
