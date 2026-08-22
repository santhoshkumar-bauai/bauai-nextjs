import type { MessageContentComplex } from "@langchain/core/messages";

import type { PdfDocumentClass } from "../types";

/**
 * Sending the PDF itself to the model.
 *
 * Probe P2 confirmed Gemini accepts a response schema and an inline PDF in the
 * SAME call, and genuinely reads the file — it returned the procurement
 * reference, the project title and every label in document order from a file
 * whose text was never put in the prompt. So there is no two-call split.
 */

/** Mirrors NATIVE_PDF_MAX_BYTES in lib/ai/agent/attachments.ts. */
export function nativeMaxBytes(): number {
  const raw = Number(process.env.PDF_FILL_NATIVE_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 8 * 1024 * 1024;
}

/**
 * The LangChain standard base64 file block. This is byte-for-byte the shape
 * proven in production by resolveMediaParts (lib/ai/agent/attachments.ts) —
 * each provider adapter converts it to its own document input (Gemini
 * inlineData, Anthropic document block, OpenAI file part).
 *
 * Deliberately NOT the `media_ref` indirection used for chat attachments: that
 * exists to keep LangGraph checkpoints free of base64, and discovery is a
 * single uncheckpointed structured call.
 */
export function pdfFileBlock(bytes: Buffer, fileName: string): MessageContentComplex {
  return {
    type: "file",
    source_type: "base64",
    mime_type: "application/pdf",
    data: bytes.toString("base64"),
    metadata: { filename: fileName },
  } as unknown as MessageContentComplex;
}

/**
 * Whether to attach the PDF itself rather than relying on the manifest alone.
 *
 * For a scanned document the pixels are the ONLY signal, so this is not
 * optional there — an oversized scan fails loudly rather than quietly
 * discovering zero fields. For the other classes the manifest already carries
 * the text, and the file adds layout and visual context on top.
 */
export function shouldSendPdfNatively(input: {
  bytes: number;
  documentClass: PdfDocumentClass;
}): boolean {
  if (input.bytes > nativeMaxBytes()) {
    if (input.documentClass === "scanned") throw new Error("pdf_too_large_for_vision");
    return false;
  }
  if (input.documentClass === "scanned") return true;
  return process.env.PDF_FILL_NATIVE_ALWAYS !== "false";
}
