import { logger } from "../observability/logger.ts";
import { metrics } from "../observability/metrics.ts";
import type { TextStatus } from "./types.ts";

const log = logger.child("documents.text");

/**
 * Plain-text extraction so tender search can match document content, not just the
 * notice. Extraction never fails a document: the archived bytes are the deliverable,
 * and text is an enrichment (§8 keeps enrichment off the critical path).
 */
export interface ExtractedText {
  status: TextStatus;
  text: string;
  error?: string;
}

const PDF = /^application\/pdf$/i;
const DOCX =
  /^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document$/i;
const PLAIN = /^text\/(plain|csv|html)$/i;
const XML = /^(text|application)\/xml$/i;

export function canExtractText(mimeType: string, fileName: string): boolean {
  return classify(mimeType, fileName) !== null;
}

function classify(mimeType: string, fileName: string): "pdf" | "docx" | "text" | null {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  const name = fileName.toLowerCase();

  if (PDF.test(type) || name.endsWith(".pdf")) return "pdf";
  if (DOCX.test(type) || name.endsWith(".docx")) return "docx";
  if (PLAIN.test(type) || XML.test(type)) return "text";
  if (/\.(txt|csv|md|xml|html?)$/.test(name)) return "text";
  return null;
}

export async function extractText(
  body: Buffer,
  mimeType: string,
  fileName: string,
): Promise<ExtractedText> {
  const kind = classify(mimeType, fileName);
  if (!kind) {
    // .doc, .xlsx, images and CAD drawings are common in tender packs and are simply
    // archived without text. Recorded as UNSUPPORTED, not FAILED.
    return { status: "UNSUPPORTED", text: "" };
  }

  const startedAt = Date.now();
  try {
    const text = await run(kind, body, fileName);
    const normalized = normalize(text);

    metrics.observe("ingestion_document_text_ms", Date.now() - startedAt, { kind });
    if (!normalized) {
      // A scanned PDF has pages but no text layer. Distinguishing this from a parse
      // failure matters: it tells us OCR would be needed, not a bug fix.
      return { status: "UNSUPPORTED", text: "", error: "no text layer" };
    }
    return { status: "DONE", text: normalized };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("text extraction failed", { fileName, kind, error: message.slice(0, 200) });
    metrics.increment("ingestion_document_text_failures_total", { kind });
    return { status: "FAILED", text: "", error: message.slice(0, 300) };
  }
}

async function run(
  kind: "pdf" | "docx" | "text",
  body: Buffer,
  fileName: string,
): Promise<string> {
  if (kind === "text") {
    const raw = body.toString("utf8");
    return /\.html?$/i.test(fileName) ? stripHtml(raw) : raw;
  }

  if (kind === "pdf") {
    ensureMathSumPrecise();
    // Imported lazily: pdfjs pulls in a large module graph that a worker handling
    // only ZIPs and spreadsheets should not pay for at startup.
    const { extractText: extractPdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(body), {
      // pdfjs is extremely chatty on real-world tender PDFs — missing embedded fonts,
      // and a `Math.sumPrecise` feature probe that fails on this Node version. Every
      // one of those is written to the console per page. At 500k+ documents that
      // buries the ingestion logs, and none of it is actionable.
      verbosity: 0,
      // Embedded fonts are irrelevant when only the text layer is wanted, and loading
      // system fonts in a container is a portability problem.
      useSystemFonts: false,
    });
    const { text } = await extractPdfText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n") : text;
  }

  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: body });
  return result.value;
}

/**
 * Polyfills `Math.sumPrecise`, which pdfjs calls unconditionally.
 *
 * It is a TC39 proposal that this Node version does not implement, so affected PDFs
 * failed extraction with `TypeError: Math.sumPrecise is not a function` — silently
 * losing their text while the file itself stored fine. Uses Neumaier compensated
 * summation, which is what the proposal specifies: exact enough that the running
 * compensation term recovers the low-order bits ordinary addition discards.
 */
function ensureMathSumPrecise(): void {
  const target = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };
  if (typeof target.sumPrecise === "function") return;

  target.sumPrecise = (values: Iterable<number>): number => {
    let sum = 0;
    let compensation = 0;

    for (const value of values) {
      const next = sum + value;
      compensation +=
        Math.abs(sum) >= Math.abs(value)
          ? sum - next + value
          : value - next + sum;
      sum = next;
    }
    return sum + compensation;
  };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/** Collapses the whitespace PDF extraction leaves behind, keeping paragraph breaks. */
function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}
