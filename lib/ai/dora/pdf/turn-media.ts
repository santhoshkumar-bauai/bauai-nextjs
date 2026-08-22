import type { MessageContentComplex } from "@langchain/core/messages";

import { getWorkspaceDocumentText } from "../document-text.ts";
import type { DoraRunContext } from "../context.ts";

/**
 * The open PDF, handed to the model as a file it can actually look at.
 *
 * Only for scans. A digital PDF's text layer is cheaper, more precise and
 * already reachable through read_current_document; pixels add nothing. But a
 * scanned PDF extracts to nothing, and today that produces a "no text layer"
 * shrug at a document the model could simply read.
 *
 * This cannot be a tool: a LangChain tool returns a string, so it has no way
 * to hand the model an image. The file has to be part of the user turn — the
 * same mechanism chat attachments already use.
 *
 * Emits a `media_ref` part rather than inline base64 so LangGraph checkpoints
 * stay byte-light; resolveMediaParts swaps in the bytes at model-call time.
 */

/** Mirrors NATIVE_PDF_MAX_BYTES in lib/ai/agent/attachments.ts. */
const NATIVE_PDF_MAX_BYTES = 8 * 1024 * 1024;

export async function buildPdfTurnMedia(
  ctx: DoraRunContext,
): Promise<MessageContentComplex[]> {
  if (ctx.document.documentType !== "pdf") return [];
  if (process.env.DORA_PDF_VISION_ENABLED === "false") return [];

  const version = ctx.document.version;
  if (!version?.s3Key) return [];
  if ((version.size ?? 0) > NATIVE_PDF_MAX_BYTES) return [];

  // Only when extraction actually came up empty. This reuses the cached text
  // row, so it costs a keyed lookup rather than a re-extraction.
  const text = await getWorkspaceDocumentText(ctx.document, ctx.tenantId);
  if (text.note !== "no_text_layer") return [];

  return [
    {
      type: "media_ref",
      s3Key: version.s3Key,
      mimeType: "application/pdf",
      fileName: ctx.document.fileName,
    } as unknown as MessageContentComplex,
  ];
}
