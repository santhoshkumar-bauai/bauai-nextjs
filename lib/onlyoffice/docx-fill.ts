import JSZip from "jszip";

import type { DocumentFillLocator } from "@/lib/ai/dora/fill/types";

/**
 * Only the two OOXML strategies. Narrowed out of the shared locator union so a
 * PDF locator routed here is a compile error rather than a runtime surprise —
 * generate.ts dispatches on the run format, and this is the backstop.
 */
export type DocxFillLocator = Extract<
  DocumentFillLocator,
  { strategy: "form_key" | "unique_text" }
>;

export type DocxFillInstruction = { id: string; value: string } & DocxFillLocator;

const WORD_PART = /^word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml$/;

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value: string) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function replaceTextInParagraph(paragraph: string, needle: string, value: string) {
  const regex = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  const nodes: Array<{ start: number; end: number; text: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(paragraph))) {
    const relative = match[0].indexOf(match[1]);
    nodes.push({
      start: match.index + relative,
      end: match.index + relative + match[1].length,
      text: decodeXml(match[1]),
    });
  }
  const flat = nodes.map((node) => node.text).join("");
  const positions: number[] = [];
  let cursor = 0;
  while ((cursor = flat.indexOf(needle, cursor)) >= 0) {
    positions.push(cursor);
    cursor += needle.length;
  }
  if (positions.length !== 1) return { count: positions.length, xml: paragraph };

  const start = positions[0];
  const end = start + needle.length;
  let offset = 0;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  let inserted = false;
  for (const node of nodes) {
    const nodeStart = offset;
    const nodeEnd = offset + node.text.length;
    offset = nodeEnd;
    if (nodeEnd <= start || nodeStart >= end) continue;
    const localStart = Math.max(0, start - nodeStart);
    const localEnd = Math.min(node.text.length, end - nodeStart);
    const replacement =
      node.text.slice(0, localStart) +
      (inserted ? "" : value) +
      node.text.slice(localEnd);
    inserted = true;
    edits.push({ start: node.start, end: node.end, value: escapeXml(replacement) });
  }
  let xml = paragraph;
  for (const edit of edits.reverse()) {
    xml = xml.slice(0, edit.start) + edit.value + xml.slice(edit.end);
  }
  return { count: 1, xml };
}

function countUniqueText(xml: string, needle: string) {
  let total = 0;
  for (const paragraph of xml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? []) {
    total += replaceTextInParagraph(paragraph, needle, "").count;
  }
  return total;
}

function replaceUniqueText(xml: string, needle: string, value: string) {
  let replaced = false;
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraph) => {
    const result = replaceTextInParagraph(paragraph, needle, value);
    if (result.count === 1) {
      if (replaced) throw new Error("locator_preflight_changed");
      replaced = true;
      return result.xml;
    }
    return paragraph;
  });
}

function taggedControls(xml: string, formKey: string) {
  const escaped = escapeXml(formKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const controls = xml.match(/<w:sdt\b[\s\S]*?<\/w:sdt>/g) ?? [];
  return controls.filter((control) =>
    new RegExp(`<w:tag\\b[^>]*\\bw:val=(?:"${escaped}"|'${escaped}')`).test(control),
  );
}

function fillTaggedControl(xml: string, formKey: string, value: string) {
  const target = taggedControls(xml, formKey)[0];
  if (!target) return xml;
  let wrote = false;
  const filled = target.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (_all, open, _text, close) => {
    const text = wrote ? "" : escapeXml(value);
    wrote = true;
    return `${open}${text}${close}`;
  });
  if (!wrote) throw new Error(`form_has_no_text:${formKey}`);
  return xml.replace(target, filled);
}

/**
 * Mutates a copy of a DOCX package only after every locator resolves exactly
 * once. Source bytes are never touched. Existing OOXML structure, styles,
 * relationships, drawings, and layout stay byte-for-byte unchanged outside
 * the targeted text nodes.
 */
export async function fillDocxBuffer(
  source: Buffer,
  fields: DocxFillInstruction[],
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(source);
  const parts = await Promise.all(
    Object.values(zip.files)
      .filter((file) => !file.dir && WORD_PART.test(file.name))
      .map(async (file) => [file.name, await file.async("string")] as const),
  );
  const xmlByPart = new Map(parts);

  const locatorKeys = fields.map((field) =>
    field.strategy === "form_key" ? `form:${field.formKey}` : `text:${field.searchText}`,
  );
  if (new Set(locatorKeys).size !== locatorKeys.length) {
    throw new Error("duplicate_fill_locator");
  }

  for (const field of fields) {
    const count = [...xmlByPart.values()].reduce(
      (total, xml) =>
        total +
        (field.strategy === "form_key"
          ? taggedControls(xml, field.formKey).length
          : countUniqueText(xml, field.searchText)),
      0,
    );
    if (count !== 1) throw new Error(`locator_preflight_failed:${field.id}:${count}`);
  }

  for (const field of fields) {
    for (const [name, xml] of xmlByPart) {
      const next =
        field.strategy === "form_key"
          ? fillTaggedControl(xml, field.formKey, field.value)
          : countUniqueText(xml, field.searchText) === 1
            ? replaceUniqueText(xml, field.searchText, field.value)
            : xml;
      if (next !== xml) xmlByPart.set(name, next);
    }
  }
  for (const [name, xml] of xmlByPart) zip.file(name, xml);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
