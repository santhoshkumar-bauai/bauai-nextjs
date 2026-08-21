export const OPEN_GENERATED_DOCUMENT_MESSAGE = "bau:dora:open-generated-document";

const OBJECT_ID_PATTERN = /^[a-f\d]{24}$/i;

export function generatedDocumentIdFromEditorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const message = value as { type?: unknown; documentId?: unknown };
  if (
    message.type !== OPEN_GENERATED_DOCUMENT_MESSAGE ||
    typeof message.documentId !== "string" ||
    !OBJECT_ID_PATTERN.test(message.documentId)
  ) {
    return null;
  }

  return message.documentId;
}
