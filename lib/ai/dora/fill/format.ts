import type { DocumentFillFormat } from "./types";

/**
 * One fill-run collection serves both engines. `document_fill_runs` is keyed by
 * document and a WorkspaceDocument has exactly one documentType, so no
 * cross-format collision is possible; the run envelope (status/stage ladder,
 * serialize, patch, generation disposition, the chat tools, the panel's polling
 * loop) is entirely format-agnostic and touches `locator` only as an opaque
 * truthiness check. A second collection would fork all of it for nothing.
 */

/** Rows written before PDF support carry no `format`; they are all docx. */
export function fillRunFormat(run: { format?: DocumentFillFormat }): DocumentFillFormat {
  return run.format ?? "docx";
}

/**
 * The engine for a workspace document, or null when neither can fill it.
 * Both halves are checked because documentType and extension are stored
 * independently and a mismatch means the row is wrong, not that we should guess.
 */
export function fillFormatFor(doc: {
  documentType: string;
  extension: string;
}): DocumentFillFormat | null {
  if (doc.documentType === "word" && doc.extension === "docx") return "docx";
  if (doc.documentType === "pdf" && doc.extension === "pdf") return "pdf";
  return null;
}
