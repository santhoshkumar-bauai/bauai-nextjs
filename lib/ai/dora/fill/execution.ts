import type { DocumentFillFormat } from "./types";

export type DocumentFillExecutionMode = "inline" | "queue";
export type FillGenerationDisposition = "generate" | "completed" | "review_required";

/** Default ceiling for running a PDF analysis inside the request. */
const PDF_INLINE_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

export function pdfInlineMaxBytes(value = process.env.PDF_INLINE_MAX_BYTES): number {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? raw : PDF_INLINE_DEFAULT_MAX_BYTES;
}

/**
 * Whether this analysis is too heavy to run inside the request.
 *
 * PDF discovery uploads the whole file to the model, so a large scan will
 * outrun the route's budget and time out with a half-written run. Refusing up
 * front with a clear code beats failing deep in the request. Word analysis
 * sends a snapshot the editor already produced, so it has no such ceiling.
 *
 * Queue mode is the supported production setting once PDF filling is enabled;
 * this only bites deployments left on the inline default.
 */
export function fillRequiresQueueMode(input: {
  format: DocumentFillFormat;
  sizeBytes: number;
  mode?: DocumentFillExecutionMode;
  maxBytes?: number;
}): boolean {
  const mode = input.mode ?? documentFillExecutionMode();
  if (mode === "queue" || input.format !== "pdf") return false;
  return input.sizeBytes > (input.maxBytes ?? pdfInlineMaxBytes());
}

/** Default ceiling for running a GAEB batch loop inside the request. */
const GAEB_INLINE_DEFAULT_MAX_ITEMS = 60;

export function gaebInlineMaxItems(value = process.env.AI_GAEB_FILL_INLINE_MAX_ITEMS): number {
  const raw = Number(value);
  return Number.isFinite(raw) && raw > 0 ? raw : GAEB_INLINE_DEFAULT_MAX_ITEMS;
}

/**
 * The GAEB analogue of the PDF gate: a 500-position LV runs dozens of model
 * calls over several minutes — far past any request budget. Above the ceiling
 * the run must go through the queue worker.
 */
export function gaebFillRequiresQueueMode(input: {
  itemCount: number;
  mode?: DocumentFillExecutionMode;
  maxItems?: number;
}): boolean {
  const mode = input.mode ?? documentFillExecutionMode();
  if (mode === "queue") return false;
  return input.itemCount > (input.maxItems ?? gaebInlineMaxItems());
}

export function fillGenerationDisposition(
  run: { status: string } | null,
): FillGenerationDisposition {
  if (run?.status === "completed") return "completed";
  if (run?.status === "review") return "generate";
  return "review_required";
}

export function documentFillExecutionMode(
  value = process.env.ONLYOFFICE_FILL_EXECUTION_MODE,
): DocumentFillExecutionMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "inline") return "inline";
  if (normalized === "queue") return "queue";
  throw new Error(
    `Invalid ONLYOFFICE_FILL_EXECUTION_MODE "${value}". Expected "inline" or "queue".`,
  );
}

export async function dispatchDocumentFillTask(input: {
  inline: () => Promise<void>;
  queued: () => Promise<void>;
  mode?: DocumentFillExecutionMode;
}): Promise<DocumentFillExecutionMode> {
  const mode = input.mode ?? documentFillExecutionMode();
  await (mode === "queue" ? input.queued() : input.inline());
  return mode;
}
