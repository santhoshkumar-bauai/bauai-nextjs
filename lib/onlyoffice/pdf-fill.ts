import type {
  PDFCheckBox,
  PDFDropdown,
  PDFFont,
  PDFForm,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
} from "pdf-lib";

import { buildPdfManifest, type PdfManifest } from "@/lib/ai/dora/fill/pdf/manifest";
import { isCheckboxTruthy, occurrenceCount } from "@/lib/ai/dora/fill/pdf/resolve-pdf";
import { locatorKey } from "@/lib/ai/dora/fill/locators";
import type { DocumentFillLocator } from "@/lib/ai/dora/fill/types";

/**
 * Deterministic PDF filling, structured as a mirror of docx-fill.ts so the two
 * engines can be read against each other.
 *
 * Same three-phase invariant:
 *   1. no two instructions may target the same thing;
 *   2. EVERY target must resolve exactly once, checked before any mutation;
 *   3. only then mutate.
 *
 * Source bytes are never touched, and a failure at any point leaves no output
 * at all — a half-filled legal document is worse than none.
 */

/**
 * Only the two writable PDF strategies. `pdf_overlay_vision` is deliberately
 * excluded: its geometry is model-derived and nothing verifies it, so it is a
 * compile error here and a runtime throw in phase 1.
 */
export type PdfWritableLocator = Extract<
  DocumentFillLocator,
  { strategy: "pdf_acroform" | "pdf_overlay_text" }
>;

export type PdfFillInstruction = { id: string; value: string } & PdfWritableLocator;

/**
 * What may actually arrive: fill fields are rebuilt from Mongo documents, so
 * the locator union is only as narrow as the data happens to be. Phase 1
 * narrows it, and that rejection lives here rather than at each call site.
 */
export type PdfFillCandidate = { id: string; value: string } & DocumentFillLocator;

export function narrowPdfInstructions(fields: PdfFillCandidate[]): PdfFillInstruction[] {
  return fields.map((field) => {
    if (field.strategy === "pdf_overlay_vision") {
      // Model-derived geometry that nothing verified. Three gates stop it
      // reaching here; this is the last.
      throw new Error("vision_locator_not_generatable");
    }
    if (field.strategy === "form_key" || field.strategy === "unique_text") {
      throw new Error("docx_locator_in_pdf");
    }
    return field;
  });
}

export interface PdfFillOptions {
  /**
   * Unicode fallback font for values WinAnsi cannot encode. Not shipped in
   * Phase 2 — German, English, French, Spanish and Italian all fit CP1252, and
   * a value outside it fails loudly rather than silently mangling. Kept in the
   * signature so a font can be supplied later without a redesign.
   */
  unicodeFontBytes?: Uint8Array;
  /** Off by default; PDFs open editable, and flattening is irreversible. */
  flatten?: boolean;
  /** When set, the document's manifest must still hash to this. */
  expectedManifestHash?: string;
}

const MIN_FONT_SIZE = 6;
const DEFAULT_FONT_SIZE = 11;

export async function fillPdfBuffer(
  source: Buffer,
  candidates: PdfFillCandidate[],
  options: PdfFillOptions = {},
): Promise<Buffer> {
  const { PDFDocument, StandardFonts, PDFName, rgb } = await import("pdf-lib");

  /* ---------------------------------------------------- phase 1: identity */
  const fields = narrowPdfInstructions(candidates);
  const keys = fields.map((field) => locatorKey(field));
  if (new Set(keys).size !== keys.length) throw new Error("duplicate_fill_locator");

  /* --------------------------------------------------- phase 2: preflight */
  // Work on a copy. pdf-lib does not clone every stream on load, and pdf.js
  // (via the manifest) may transfer the ArrayBuffer outright.
  const working = Uint8Array.from(source);
  const doc = await PDFDocument.load(working, { updateMetadata: false });
  const form = doc.getForm();
  const pages = doc.getPages();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const needsManifest = fields.some((field) => field.strategy === "pdf_overlay_text");
  // Re-derived from the bytes about to be written, not carried in from
  // analysis — that removes the "manifest describes a different document"
  // hazard entirely rather than trying to detect it.
  let manifest: PdfManifest | null = null;
  if (needsManifest || options.expectedManifestHash) {
    manifest = await buildPdfManifest(Uint8Array.from(source));
    if (options.expectedManifestHash && manifest.manifestHash !== options.expectedManifestHash) {
      throw new Error("pdf_manifest_mismatch");
    }
  }

  const acroTargets = new Map<string, ReturnType<PDFForm["getFields"]>[number]>();
  for (const field of fields) {
    if (field.strategy === "pdf_acroform") {
      const matches = form.getFields().filter((f) => f.getName() === field.fieldName);
      // Exactly-once, same error shape as docx so the panel renders it
      // unchanged. Note this counts FIELDS: one field with many widgets is a
      // single match, which is the intended semantics.
      if (matches.length !== 1) {
        throw new Error(`locator_preflight_failed:${field.id}:${matches.length}`);
      }
      const [target] = matches;
      if (actualType(target) !== field.fieldType) {
        throw new Error(`locator_field_type_changed:${field.id}`);
      }
      if (target.isReadOnly()) throw new Error(`locator_read_only:${field.id}`);
      rejectUnusableValue(field, target);
      acroTargets.set(field.id, target);
    } else {
      const count = occurrenceCount(manifest!.lines, field.anchorText);
      if (count !== 1) throw new Error(`locator_preflight_failed:${field.id}:${count}`);
      if (field.page >= pages.length) throw new Error(`locator_page_missing:${field.id}`);
    }
  }

  // Encoding preflight. Checked for EVERY value up front so one un-encodable
  // character can never leave a document half-written.
  for (const field of fields) {
    if (!isEncodable(font, field.value)) {
      throw new Error(`pdf_value_not_encodable:${field.id}`);
    }
  }

  /* ------------------------------------------------------ phase 3: mutate */
  for (const field of fields) {
    if (field.strategy !== "pdf_acroform") continue;
    const target = acroTargets.get(field.id)!;
    switch (field.fieldType) {
      case "text":
        (target as PDFTextField).setText(field.value);
        break;
      case "checkbox": {
        const truthy = isCheckboxTruthy(field.value);
        const box = target as PDFCheckBox;
        if (truthy === false) box.uncheck();
        else box.check();
        break;
      }
      case "radio":
        (target as PDFRadioGroup).select(field.value);
        break;
      case "dropdown":
        (target as PDFDropdown).select(field.value);
        break;
      case "optionlist":
        (target as PDFOptionList).select(field.value);
        break;
    }
  }

  for (const field of fields) {
    if (field.strategy !== "pdf_overlay_text") continue;
    const page = pages[field.page];
    if (field.whiteout && field.rect.width > 0 && field.rect.height > 0) {
      page.drawRectangle({
        x: field.rect.x,
        y: field.rect.y,
        width: field.rect.width,
        height: field.rect.height,
        color: rgb(1, 1, 1),
        borderWidth: 0,
      });
    }
    const size = fitFontSize(font, field.value, field.fontSize || DEFAULT_FONT_SIZE, field.rect.width);
    page.drawText(field.value, {
      x: field.baseline.x,
      y: field.baseline.y,
      size,
      font,
      color: rgb(0, 0, 0),
      // NOT maxWidth: pdf-lib WRAPS on maxWidth, pushing text down into
      // whatever sits below. Shrinking keeps it on its own line.
    });
  }

  if (acroTargets.size > 0) {
    // Once, after every set — not per field. Without regenerated appearance
    // streams many viewers show a stale or blank widget even though /V is set.
    try {
      form.updateFieldAppearances(font);
    } catch (error) {
      throw new Error(
        `field_appearance_failed:${error instanceof Error ? error.message.slice(0, 80) : "unknown"}`,
      );
    }
    // Drop /NeedAppearances so no viewer re-blanks the streams we just wrote.
    const acro = doc.catalog.lookup(PDFName.of("AcroForm")) as
      | { delete?: (key: unknown) => void }
      | undefined;
    acro?.delete?.(PDFName.of("NeedAppearances"));
  }

  if (options.flatten) form.flatten();

  // useObjectStreams:false keeps the output byte-deterministic (so golden-hash
  // fixture tests mean something) and readable by stricter legacy validators.
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

export interface PdfVerificationFailure {
  id: string;
  reason: string;
}

/**
 * Reopen the produced bytes and prove the writes landed.
 *
 * PDF writes fail far more quietly than OOXML text edits: a value can be set
 * on a field that renders blank, and an overlay can be drawn a hundred points
 * from where it was meant to go without anything erroring. This has no Word
 * analogue because Word needs none.
 */
export async function verifyFilledPdf(
  output: Buffer,
  fields: PdfFillInstruction[],
  sourcePageCount: number,
): Promise<{ ok: true } | { ok: false; failures: PdfVerificationFailure[] }> {
  const { PDFDocument } = await import("pdf-lib");
  const failures: PdfVerificationFailure[] = [];

  const doc = await PDFDocument.load(Uint8Array.from(output), { updateMetadata: false });
  if (doc.getPageCount() !== sourcePageCount) {
    failures.push({
      id: "-",
      reason: `page count changed from ${sourcePageCount} to ${doc.getPageCount()}`,
    });
  }

  const form = doc.getForm();
  for (const field of fields) {
    if (field.strategy !== "pdf_acroform") continue;
    try {
      const target = form.getField(field.fieldName);
      const readBack = readValue(target, field.fieldType);
      if (!valuesAgree(field, readBack)) {
        failures.push({ id: field.id, reason: `read back ${JSON.stringify(readBack)}` });
        continue;
      }
      // /V without an appearance stream renders blank in most viewers.
      const missingAp = target.acroField
        .getWidgets()
        .some((widget) => !widget.getAppearances()?.normal);
      if (missingAp) failures.push({ id: field.id, reason: "widget has no appearance stream" });
    } catch (error) {
      failures.push({
        id: field.id,
        reason: error instanceof Error ? error.message.slice(0, 120) : "unreadable",
      });
    }
  }

  const overlays = fields.filter((field) => field.strategy === "pdf_overlay_text");
  if (overlays.length > 0) {
    const { extractTextItems } = await import("unpdf");
    const extracted = await extractTextItems(Uint8Array.from(output));
    for (const field of overlays) {
      if (field.strategy !== "pdf_overlay_text") continue;
      const items = extracted.items[field.page] ?? [];
      // Expanded by 2pt: this is what catches "drew at the wrong y", the most
      // likely coordinate bug in the whole engine.
      const inPlace = items.some(
        (item) =>
          item.str.includes(field.value.trim().slice(0, 24)) &&
          item.x >= field.rect.x - 2 &&
          item.x <= field.rect.x + field.rect.width + 2 &&
          item.y >= field.rect.y - 2 &&
          item.y <= field.rect.y + field.rect.height + 2,
      );
      if (!inPlace) {
        failures.push({ id: field.id, reason: "value not found within its target area" });
      }
    }
  }

  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/* ------------------------------------------------------------------ helpers */

function actualType(field: unknown): string {
  switch ((field as { constructor: { name: string } }).constructor.name) {
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
      return "button";
  }
}

/** pdf-lib's encoder throws on characters WinAnsi cannot represent. */
function isEncodable(font: PDFFont, value: string): boolean {
  try {
    font.widthOfTextAtSize(value, DEFAULT_FONT_SIZE);
    return true;
  } catch {
    return false;
  }
}

function fitFontSize(font: PDFFont, value: string, preferred: number, width: number): number {
  if (width <= 0) return preferred;
  let size = preferred;
  while (size > MIN_FONT_SIZE && font.widthOfTextAtSize(value, size) > width) {
    size -= 0.5;
  }
  return size;
}

function rejectUnusableValue(field: PdfFillInstruction, target: unknown): void {
  if (field.strategy !== "pdf_acroform") return;
  if (field.fieldType === "checkbox") {
    if (isCheckboxTruthy(field.value) === null) {
      throw new Error(`locator_value_rejected:${field.id}`);
    }
    return;
  }
  if (
    field.fieldType === "radio" ||
    field.fieldType === "dropdown" ||
    field.fieldType === "optionlist"
  ) {
    const options = (target as { getOptions?: () => string[] }).getOptions?.() ?? [];
    if (options.length > 0 && !options.includes(field.value)) {
      throw new Error(`locator_value_rejected:${field.id}`);
    }
  }
}

function readValue(field: unknown, type: string): string | string[] | boolean | undefined {
  const f = field as Record<string, () => unknown>;
  if (type === "text") return f.getText?.() as string | undefined;
  if (type === "checkbox") return f.isChecked?.() as boolean;
  if (type === "radio") return f.getSelected?.() as string | undefined;
  return f.getSelected?.() as string[] | undefined;
}

function valuesAgree(field: PdfFillInstruction, readBack: unknown): boolean {
  if (field.strategy !== "pdf_acroform") return true;
  if (field.fieldType === "checkbox") return readBack === isCheckboxTruthy(field.value);
  if (field.fieldType === "dropdown" || field.fieldType === "optionlist") {
    return Array.isArray(readBack) && readBack.includes(field.value);
  }
  return readBack === field.value;
}
