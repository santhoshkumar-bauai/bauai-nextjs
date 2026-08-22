import type { PdfDocumentClass } from "../types";
import { toPlainBytes } from "./bytes";

/**
 * How a PDF's fillable surface is shaped. This picks the PRIMARY strategy and
 * the confidence ceiling, not the whole manifest — an AcroForm PDF still gets
 * its text lines extracted so the model can propose overlays for blanks the
 * form does not cover.
 *
 *   acroform  interactive form fields exist -> deterministic, name-addressed
 *   digital   a real text layer -> overlay anchored to unique label text
 *   scanned   no usable text -> vision only, and vision can never auto-apply
 */

/** Below this many characters per page there is nothing to anchor against. */
function digitalThreshold(): number {
  const raw = Number(process.env.PDF_DIGITAL_MIN_CHARS_PER_PAGE);
  return Number.isFinite(raw) && raw > 0 ? raw : 120;
}

export interface PdfPageGeometry {
  /** MediaBox size in points. Matches pdf-lib page.getSize(). */
  width: number;
  height: number;
  /** Page /Rotate, normalized to 0/90/180/270. */
  rotation: number;
  /**
   * CropBox origin minus MediaBox origin. pdf.js reports text coordinates
   * relative to the CROP box; pdf-lib draws relative to the MEDIA box. On the
   * overwhelming majority of documents these coincide and this is {0,0}, but
   * when they do not, every extracted coordinate needs this added to land in
   * the space the writer uses. Applied once, in manifest.ts.
   */
  cropOffset: { x: number; y: number };
}

export interface PdfClassification {
  documentClass: PdfDocumentClass;
  pageCount: number;
  pages: PdfPageGeometry[];
  acroFieldCount: number;
  textCharCount: number;
  charsPerPage: number;
}

/** Total non-whitespace-trimmed length of every extracted text item. */
export function countTextChars(pages: Array<Array<{ str: string }>>): number {
  return pages.reduce(
    (total, items) => total + items.reduce((n, item) => n + item.str.trim().length, 0),
    0,
  );
}

export async function classifyPdf(bytes: Uint8Array): Promise<PdfClassification> {
  const { PDFDocument } = await import("pdf-lib");

  let doc;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    // pdf-lib throws EncryptedPDFError by name; there is nothing useful to do
    // with a password-protected file except say so.
    if (error instanceof Error && /encrypt/i.test(error.name + error.message)) {
      throw new Error("pdf_encrypted");
    }
    throw new Error("pdf_unreadable");
  }

  const pages: PdfPageGeometry[] = doc.getPages().map((page) => {
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    return {
      width: media.width,
      height: media.height,
      rotation: ((page.getRotation().angle % 360) + 360) % 360,
      cropOffset: { x: crop.x - media.x, y: crop.y - media.y },
    };
  });

  // NOTE: getForm() CREATES an /AcroForm on a document that has none. Harmless
  // here because this instance is never saved — but the fill engine must load
  // its own fresh PDFDocument, never reuse one that has been classified.
  const acroFieldCount = doc.getForm().getFields().length;

  const { extractTextItems } = await import("unpdf");
  const extracted = await extractTextItems(toPlainBytes(bytes));
  const textCharCount = countTextChars(extracted.items);
  const pageCount = pages.length;
  const charsPerPage = pageCount > 0 ? textCharCount / pageCount : 0;

  const documentClass: PdfDocumentClass =
    acroFieldCount > 0 ? "acroform" : charsPerPage >= digitalThreshold() ? "digital" : "scanned";

  return { documentClass, pageCount, pages, acroFieldCount, textCharCount, charsPerPage };
}
