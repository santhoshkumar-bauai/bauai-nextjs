import { createHash } from "node:crypto";

import { isSensitiveField } from "../sensitive";
import type {
  DocumentFillEvidence,
  DocumentFillField,
  DocumentFillLocator,
  PdfRect,
} from "../types";
import type { PdfManifest, PdfTextLineEntry } from "./manifest";
import type { PdfFillDiscovery } from "./schema-pdf";

/**
 * The deterministic gate between the model and the writer, mirroring
 * ../resolve.ts line for line.
 *
 * The model proposes; nothing it says about POSITION is taken on trust. Every
 * locator here is either rebuilt from the manifest (acroform, overlay_text) or
 * explicitly marked unverifiable (overlay_vision). The model never decides a
 * field's `state` or its `locator`.
 */

/** Smallest writable span worth attempting, in points. */
const MIN_OVERLAY_WIDTH = 8;
const MIN_VISION_WIDTH = 8;
const MIN_VISION_HEIGHT = 6;
/** A widget smaller than this is decorative or broken. */
const MIN_WIDGET_SIDE = 4;
/** Gap left between the label and the value we write after it. */
const LABEL_GAP = 4;
/** Values a checkbox understands, beyond its own export value. */
const TRUTHY = new Set(["true", "yes", "ja", "on", "1", "x", "checked"]);
const FALSY = new Set(["false", "no", "nein", "off", "0", "", "unchecked"]);

const FILLABLE = new Set(["text", "checkbox", "radio", "dropdown", "optionlist"]);

/**
 * Width of a string at a font size, in points. Supplied by the caller so this
 * module stays pure and synchronous while still getting real metrics; the
 * analyzer embeds a standard font once and passes its measurer in.
 */
export type MeasureText = (text: string, size: number) => number;

export function isCheckboxTruthy(value: string): boolean | null {
  const v = value.trim().toLowerCase();
  if (TRUTHY.has(v)) return true;
  if (FALSY.has(v)) return false;
  return null;
}

/**
 * How many times `needle` occurs across EVERY line of EVERY page.
 *
 * Global, not per-page and not per-line — direct port of the Word resolver's
 * occurrenceCount. This is the invariant that lets the generation preflight
 * mean something: if an anchor is unique now and unique again at write time,
 * the thing being written to is the same thing that was reviewed.
 */
export function occurrenceCount(lines: PdfTextLineEntry[], needle: string): number {
  if (!needle) return 0;
  return lines.reduce((total, line) => {
    let index = 0;
    let count = 0;
    while ((index = line.text.indexOf(needle, index)) >= 0) {
      count += 1;
      index += needle.length;
    }
    return total + count;
  }, 0);
}

/**
 * The writable span that follows `anchorText` on its line.
 *
 * Geometry comes entirely from the manifest's per-item boundaries: find the
 * item where the anchor ends, and take everything from there to the end of the
 * line. Returns null when the anchor is not actually on this line or nothing
 * usable follows it.
 */
export function spanAfterAnchor(
  line: PdfTextLineEntry,
  anchorText: string,
  pageWidth: number,
  measureText?: MeasureText,
): { rect: PdfRect; baseline: { x: number; y: number } } | null {
  const at = line.text.indexOf(anchorText);
  if (at < 0) return null;
  const anchorEnd = at + anchorText.length;

  let x: number | null = null;

  if (measureText) {
    // Real font metrics. A character-fraction estimate is badly wrong in a
    // proportional face — the error grows with label length and shows up as a
    // stub of leftover underscores in front of the value ("nummer: __ DE81…").
    x = line.baseline.x + measureText(line.text.slice(0, anchorEnd), line.fontSize);
  } else {
    // Fallback: walk the runs, turning a character offset back into an x.
    let consumed = 0;
    for (const part of line.items) {
      const found = line.text.indexOf(part.text, consumed);
      if (found < 0) continue;
      const start = found;
      const end = found + part.text.length;
      consumed = end;
      if (anchorEnd <= start) {
        x = part.x;
        break;
      }
      if (anchorEnd <= end) {
        const fraction = (anchorEnd - start) / Math.max(1, part.text.length);
        x = part.x + part.width * fraction;
        break;
      }
    }
  }
  if (x === null) return null;

  // The whiteout box starts at the anchor's END, but the text is drawn a small
  // gap further right. Sharing one origin leaves the first few points of the
  // placeholder run uncovered, which renders as "Unternehmens: _BAU Testbau
  // GmbH" — a stub of leftover underscores in front of every value.
  const boxStart = x;
  const textStart = x + LABEL_GAP;
  const lineEnd = line.rect.x + line.rect.width;
  // Prefer the rest of the line's own ink (the underscore run); if the anchor
  // is the last thing on the line, run to the right margin instead.
  const end = lineEnd > textStart + MIN_OVERLAY_WIDTH ? lineEnd : pageWidth - line.rect.x;
  if (end - textStart < MIN_OVERLAY_WIDTH) return null;

  return {
    rect: { x: boxStart, y: line.rect.y, width: end - boxStart, height: line.rect.height },
    baseline: { x: textStart, y: line.baseline.y },
  };
}

/**
 * Should the span be painted white before the value is drawn?
 *
 * pdf-lib cannot remove glyphs from a content stream, so covering is the only
 * way to replace a visible placeholder — and covering assumes a white
 * background, which a shaded or scanned page does not have. Restricted to
 * placeholder-shaped runs on genuinely digital pages, and decided HERE so the
 * writer stays a dumb executor exactly like docx-fill.ts.
 */
export function shouldWhiteout(input: {
  documentClass: string;
  line: PdfTextLineEntry;
  anchorText: string;
}): boolean {
  if (input.documentClass !== "digital") return false;
  const after = input.line.text.slice(
    input.line.text.indexOf(input.anchorText) + input.anchorText.length,
  );
  return /^[\s]*[_.·…]{3,}[\s]*$/.test(after);
}

export function resolvePdfDiscoveredFields(input: {
  discovery: PdfFillDiscovery;
  manifest: PdfManifest;
  evidence: Map<string, DocumentFillEvidence>;
  /** Omit only in tests that do not care about exact overlay geometry. */
  measureText?: MeasureText;
}): DocumentFillField[] {
  const { manifest } = input;
  const acroByNode = new Map(manifest.acroFields.map((field) => [field.nodeId, field]));
  const linesByNode = new Map(manifest.lines.map((line) => [line.nodeId, line]));
  // Two DISTINCT fields sharing a fully-qualified name make getField(name)
  // ambiguous. Note this counts fields, never widgets: one field with many
  // widgets is legitimate and shares a single value by design.
  const nameCounts = new Map<string, number>();
  for (const field of manifest.acroFields) {
    nameCounts.set(field.fieldName, (nameCounts.get(field.fieldName) ?? 0) + 1);
  }

  return input.discovery.fields.map((candidate, index) => {
    const value = candidate.value?.trim() || null;
    const built = buildLocator({
      candidate,
      value,
      manifest,
      acroByNode,
      linesByNode,
      nameCounts,
      measureText: input.measureText,
    });

    const evidence = candidate.evidenceReferences
      .map((ref) => input.evidence.get(ref))
      .filter((item): item is DocumentFillEvidence => Boolean(item));

    // Sensitivity is a one-way ratchet: the model can add it, never remove it.
    // forceSensitive covers what only the FILE knows — an /FT /Sig field is a
    // signature even when its label says nothing of the sort — and it applies
    // whether or not a locator was built, since signature fields get none.
    const sensitive =
      isSensitiveField({
        label: candidate.label,
        description: candidate.description,
        modelSaidSensitive: candidate.sensitive,
      }) || Boolean(built.forceSensitive);

    let state: DocumentFillField["state"];
    if (sensitive) state = "manual";
    else if (!value) state = "missing";
    else if (!built.locator || evidence.length === 0 || candidate.confidence < 0.7)
      state = "needs_review";
    else if (candidate.confidence >= 0.9) state = "ready";
    else state = "needs_review";

    // A scanned document's whole field set is vision-grade even when a stray
    // text layer produced an anchor, so nothing on it may auto-apply.
    if (state === "ready" && manifest.classification.documentClass === "scanned") {
      state = "needs_review";
    }
    // Vision geometry has no deterministic verification at all: nothing checks
    // the rect is empty, on-page, or clear of existing ink. Clamped AFTER the
    // normal ladder so it can only ever downgrade.
    if (built.locator?.strategy === "pdf_overlay_vision") {
      state = sensitive ? "manual" : value ? "needs_review" : "missing";
    }

    const nodeId = built.locator?.nodeId ?? candidate.nodeId ?? "";
    const id = createHash("sha256")
      .update(`${nodeId}\0${candidate.label}\0${index}`)
      .digest("hex")
      .slice(0, 24);

    return {
      id,
      label: candidate.label,
      description: candidate.description,
      required: candidate.required,
      sensitive: Boolean(sensitive),
      value,
      confidence: candidate.confidence,
      state,
      locator: built.locator,
      evidence,
      reason: built.locator ? built.reason ?? candidate.reason : built.reason ?? UNRESOLVED,
      updatedBy: "ai" as const,
    };
  });
}

const UNRESOLVED = "The target could not be resolved to one exact writable location.";

function buildLocator(input: {
  candidate: PdfFillDiscovery["fields"][number];
  value: string | null;
  manifest: PdfManifest;
  acroByNode: Map<string, PdfManifest["acroFields"][number]>;
  linesByNode: Map<string, PdfTextLineEntry>;
  nameCounts: Map<string, number>;
  measureText?: MeasureText;
}): { locator: DocumentFillLocator | null; reason?: string; forceSensitive?: boolean } {
  const { candidate } = input;

  if (candidate.kind === "acroform") {
    const entry = input.acroByNode.get(candidate.nodeId);
    if (!entry) return { locator: null, reason: "No form field with that id exists." };
    if (entry.fieldType === "signature") {
      // Resolvable, but never machine-fillable.
      return { locator: null, reason: "Signature fields are always filled by a person.", forceSensitive: true };
    }
    if (!FILLABLE.has(entry.fieldType)) {
      return { locator: null, reason: "This form field type cannot hold a value." };
    }
    if (entry.readOnly) return { locator: null, reason: "This form field is read-only." };
    if ((input.nameCounts.get(entry.fieldName) ?? 0) !== 1) {
      return { locator: null, reason: "Two different form fields share this name." };
    }
    if (entry.rect.width < MIN_WIDGET_SIDE || entry.rect.height < MIN_WIDGET_SIDE) {
      return { locator: null, reason: "This form field has no usable area." };
    }
    if (input.value !== null) {
      const rejection = rejectValueForField(entry, input.value);
      if (rejection) return { locator: null, reason: rejection };
    }
    return {
      locator: {
        strategy: "pdf_acroform",
        nodeId: entry.nodeId,
        page: entry.page,
        fieldName: entry.fieldName,
        fieldType: entry.fieldType,
        widgetCount: entry.widgetCount,
        rect: entry.rect,
      },
    };
  }

  if (candidate.kind === "overlay_text") {
    const line = input.linesByNode.get(candidate.nodeId);
    if (!line) return { locator: null, reason: "No text line with that id exists." };
    const anchor = candidate.anchorText.trim();
    if (!anchor) return { locator: null, reason: "No anchor text was supplied." };
    if (!line.text.includes(anchor)) {
      return { locator: null, reason: "The anchor text is not on that line." };
    }
    const occurrences = occurrenceCount(input.manifest.lines, anchor);
    if (occurrences !== 1) {
      return {
        locator: null,
        reason: `The anchor text appears ${occurrences} times in this document, so the target is ambiguous.`,
      };
    }
    const page = input.manifest.classification.pages[line.page];
    const span = spanAfterAnchor(line, anchor, page?.width ?? 595.28, input.measureText);
    if (!span) return { locator: null, reason: "There is no writable space after the label." };
    return {
      locator: {
        strategy: "pdf_overlay_text",
        nodeId: line.nodeId,
        page: line.page,
        anchorText: anchor,
        anchorOccurrence: 1,
        rect: span.rect,
        baseline: span.baseline,
        fontSize: line.fontSize,
        whiteout: shouldWhiteout({
          documentClass: input.manifest.classification.documentClass,
          line,
          anchorText: anchor,
        }),
      },
    };
  }

  // overlay_vision
  const rect = candidate.rect;
  if (!rect) return { locator: null, reason: "No area was supplied for this field." };
  const page = input.manifest.classification.pages[candidate.page];
  if (!page) return { locator: null, reason: "That page does not exist." };
  if (rect.width < MIN_VISION_WIDTH || rect.height < MIN_VISION_HEIGHT) {
    return { locator: null, reason: "The supplied area is too small to write into." };
  }
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > page.width ||
    rect.y + rect.height > page.height
  ) {
    return { locator: null, reason: "The supplied area falls outside the page." };
  }
  const fontSize = Math.max(6, Math.min(14, rect.height * 0.7));
  return {
    locator: {
      strategy: "pdf_overlay_vision",
      nodeId: `vis:${candidate.page}:${Math.round(rect.x)}:${Math.round(rect.y)}`,
      page: candidate.page,
      rect,
      baseline: { x: rect.x + 1, y: rect.y + rect.height * 0.2 },
      fontSize,
      nearestText: candidate.anchorText.slice(0, 120),
    },
    reason: "Read from the page image; confirm the position before generating.",
  };
}

/** Null when the value is acceptable, else why it is not. */
function rejectValueForField(
  entry: PdfManifest["acroFields"][number],
  value: string,
): string | null {
  if (entry.fieldType === "checkbox") {
    if (isCheckboxTruthy(value) === null && !(entry.options ?? []).includes(value)) {
      return "The value is not a yes/no answer.";
    }
    return null;
  }
  if (entry.fieldType === "radio" || entry.fieldType === "dropdown" || entry.fieldType === "optionlist") {
    const options = entry.options ?? [];
    if (options.length > 0 && !options.includes(value)) {
      return `The value is not one of the field's allowed options (${options.join(", ")}).`;
    }
    return null;
  }
  if (entry.fieldType === "text" && entry.maxLength && value.length > entry.maxLength) {
    return `The value is longer than the field allows (${entry.maxLength} characters).`;
  }
  return null;
}
