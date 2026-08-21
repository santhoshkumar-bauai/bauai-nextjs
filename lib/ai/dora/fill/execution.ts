export type DocumentFillExecutionMode = "inline" | "queue";
export type FillGenerationDisposition = "generate" | "completed" | "review_required";

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
