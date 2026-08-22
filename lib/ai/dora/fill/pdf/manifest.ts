import { createHash } from "node:crypto";

import type { PdfFormFieldType, PdfRect } from "../types";
import { toPlainBytes } from "./bytes";
import { classifyPdf, type PdfClassification } from "./classify";

/**
 * The deterministic description of a PDF: every AcroForm field and every line
 * of text, with real geometry read from the file.
 *
 * This is the PDF analogue of the Word editor snapshot, and it plays the same
 * role — the model may only NAME things that appear here, and every coordinate
 * that ever gets written comes from here rather than from the model. See the
 * coordinate contract in ../types.ts: every rect below is unrotated PDF user
 * space, origin bottom-left, MediaBox-relative, agreeing 1:1 with pdf-lib.
 */

const MAX_PAGES = 200;
const MAX_LINES = 4_000;
/** Gap beyond this fraction of the font size is a word break. */
const WORD_GAP_RATIO = 0.25;
/** Rough descender depth as a fraction of font size. */
const DESCENDER_RATIO = 0.22;

export interface PdfManifestItem {
  text: string;
  x: number;
  width: number;
}

export interface PdfAcroFieldEntry {
  /** `af:<index>` — index into this manifest, stable for identical bytes. */
  nodeId: string;
  fieldName: string;
  fieldType: PdfFormFieldType;
  /** Page of the FIRST widget. */
  page: number;
  rect: PdfRect;
  /** >1 means linked widgets sharing one value — legitimate, never an error. */
  widgetCount: number;
  readOnly: boolean;
  required: boolean;
  currentValue: string | null;
  options: string[] | null;
  maxLength: number | null;
  /** Nearest text left of / above the widget: the field's visible label. */
  nearbyText: string;
}

export interface PdfTextLineEntry {
  /** `tl:<page>:<lineIndex>` */
  nodeId: string;
  page: number;
  text: string;
  rect: PdfRect;
  baseline: { x: number; y: number };
  fontSize: number;
  /**
   * The runs making up the line, in reading order. unpdf exposes no per-glyph
   * advances, so substring geometry is derived from these item boundaries.
   */
  items: PdfManifestItem[];
}

export interface PdfManifest {
  classification: PdfClassification;
  acroFields: PdfAcroFieldEntry[];
  lines: PdfTextLineEntry[];
  manifestHash: string;
}

export interface RawTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  hasEOL: boolean;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** pdf-lib field subclass -> our type tag. */
export function fieldTypeOf(constructorName: string): PdfFormFieldType {
  switch (constructorName) {
    case "PDFTextField":
      return "text";
    case "PDFCheckBox":
      return "checkbox";
    case "PDFRadioGroup":
      return "radio";
    case "PDFDropdown":
      return "dropdown";
    case "PDFOptionList":
      return "optionlist";
    case "PDFSignature":
      return "signature";
    default:
      // Buttons and anything unrecognised are never writable and never get a
      // locator, so collapsing them is safe.
      return "button";
  }
}

/**
 * Group a page's text items into visual lines.
 *
 * Items arrive in content-stream order, which is reading order often enough
 * but not always, so lines are bucketed by baseline y then sorted by x. The
 * bucket is proportional to the page's own median font size rather than a
 * fixed tolerance, so an 8pt page and an 18pt page both group correctly.
 */
export function groupItemsIntoLines(
  items: RawTextItem[],
  page: number,
  offset: { x: number; y: number },
): PdfTextLineEntry[] {
  const usable = items.filter((item) => item.str.trim().length > 0);
  if (usable.length === 0) return [];

  const bucketSize = Math.max(1, median(usable.map((i) => i.fontSize)) * 0.5);
  const buckets = new Map<number, RawTextItem[]>();
  for (const item of usable) {
    const key = Math.round(item.y / bucketSize);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  // Highest baseline first, so line indices read top-to-bottom.
  return [...buckets.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, bucket], index) => {
      const sorted = [...bucket].sort((a, b) => a.x - b.x);
      const fontSize = median(sorted.map((i) => i.fontSize)) || sorted[0].fontSize;

      let text = "";
      const parts: PdfManifestItem[] = [];
      let previousEnd: number | null = null;
      for (const item of sorted) {
        const gap = previousEnd === null ? 0 : item.x - previousEnd;
        // A wide gap is a word break the content stream never encoded.
        const separator =
          previousEnd !== null && gap > fontSize * WORD_GAP_RATIO && !/\s$/.test(text) ? " " : "";
        text += separator + item.str;
        parts.push({ text: item.str, x: item.x + offset.x, width: item.width });
        previousEnd = item.x + item.width;
      }

      const baselineY = median(sorted.map((i) => i.y));
      const left = sorted[0].x;
      const right = Math.max(...sorted.map((i) => i.x + i.width));
      return {
        nodeId: `tl:${page}:${index}`,
        page,
        text,
        // rect.y sits a descender BELOW the baseline; a box drawn at the
        // baseline clips every g, j, p, q and y on the line.
        rect: {
          x: left + offset.x,
          y: baselineY - fontSize * DESCENDER_RATIO + offset.y,
          width: right - left,
          height: fontSize * (1 + DESCENDER_RATIO),
        },
        baseline: { x: left + offset.x, y: baselineY + offset.y },
        fontSize,
        items: parts,
      };
    });
}

export async function buildPdfManifest(bytes: Uint8Array): Promise<PdfManifest> {
  const classification = await classifyPdf(bytes);
  if (classification.pageCount > MAX_PAGES) throw new Error("pdf_too_large");

  const acroFields = await readAcroFields(bytes);

  const { extractTextItems } = await import("unpdf");
  const extracted = await extractTextItems(toPlainBytes(bytes));
  const lines: PdfTextLineEntry[] = [];
  for (const [page, items] of extracted.items.entries()) {
    const geometry = classification.pages[page];
    if (!geometry) continue;
    lines.push(...groupItemsIntoLines(items as RawTextItem[], page, geometry.cropOffset));
    if (lines.length > MAX_LINES) throw new Error("pdf_too_large");
  }

  attachNearbyText(acroFields, lines);

  // The hash covers only what a locator can address. Including the
  // classification would make it churn on an unrelated threshold change and
  // needlessly invalidate stored runs.
  const manifestHash = createHash("sha256")
    .update(JSON.stringify({ acroFields, lines }))
    .digest("hex");

  return { classification, acroFields, lines, manifestHash };
}

/* ------------------------------------------------------------------ helpers */

async function readAcroFields(bytes: Uint8Array): Promise<PdfAcroFieldEntry[]> {
  const { PDFDocument, PDFName } = await import("pdf-lib");
  // A FRESH instance: getForm() injects an empty /AcroForm into a document
  // that has none, so an instance that has been classified must never be
  // reused for anything that gets saved.
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageRefs = doc.getPages().map((page) => String(page.ref));

  return doc
    .getForm()
    .getFields()
    .map((field, index) => {
      const widgets = field.acroField.getWidgets();
      const first = widgets[0];
      const type = fieldTypeOf(field.constructor.name);
      const parentRef = first ? String(first.dict.get(PDFName.of("P"))) : "";
      const page = Math.max(0, pageRefs.indexOf(parentRef));
      const raw = first?.getRectangle();
      return {
        nodeId: `af:${index}`,
        fieldName: field.getName(),
        fieldType: type,
        page,
        rect: raw
          ? { x: raw.x, y: raw.y, width: Math.abs(raw.width), height: Math.abs(raw.height) }
          : { x: 0, y: 0, width: 0, height: 0 },
        widgetCount: widgets.length,
        readOnly: field.isReadOnly(),
        required: field.isRequired(),
        currentValue: readValue(field, type),
        options: readOptions(field, type),
        maxLength: readMaxLength(field, type),
        nearbyText: "",
      };
    });
}

/** Nearest text left of, or immediately above, the widget. */
function attachNearbyText(entries: PdfAcroFieldEntry[], lines: PdfTextLineEntry[]) {
  for (const entry of entries) {
    const onPage = lines.filter((line) => line.page === entry.page);
    const midY = entry.rect.y + entry.rect.height / 2;
    const sameRow = onPage
      .filter(
        (line) =>
          line.baseline.y >= entry.rect.y - entry.rect.height &&
          line.baseline.y <= entry.rect.y + entry.rect.height * 2 &&
          line.rect.x < entry.rect.x,
      )
      .sort((a, b) => b.rect.x - a.rect.x);
    const above = onPage
      .filter((line) => line.baseline.y > midY)
      .sort((a, b) => a.baseline.y - b.baseline.y);
    entry.nearbyText = (sameRow[0]?.text ?? above[0]?.text ?? "").slice(0, 120);
  }
}

function readValue(field: unknown, type: PdfFormFieldType): string | null {
  try {
    const f = field as Record<string, () => unknown>;
    if (type === "text") return ((f.getText?.() as string) ?? null) || null;
    if (type === "checkbox") return f.isChecked?.() ? "true" : "false";
    if (type === "radio") return ((f.getSelected?.() as string) ?? null) || null;
    if (type === "dropdown" || type === "optionlist") {
      const selected = (f.getSelected?.() as string[]) ?? [];
      return selected.length ? selected.join(", ") : null;
    }
  } catch {
    // A single malformed field must not abort the whole manifest.
  }
  return null;
}

function readOptions(field: unknown, type: PdfFormFieldType): string[] | null {
  if (type !== "radio" && type !== "dropdown" && type !== "optionlist") return null;
  try {
    return (field as { getOptions?: () => string[] }).getOptions?.() ?? null;
  } catch {
    return null;
  }
}

function readMaxLength(field: unknown, type: PdfFormFieldType): number | null {
  if (type !== "text") return null;
  try {
    return (field as { getMaxLength?: () => number | undefined }).getMaxLength?.() ?? null;
  } catch {
    return null;
  }
}
