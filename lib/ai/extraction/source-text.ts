import { loadDocumentFile } from "../../ingestion/documents/store.ts";
import type { StoredDocumentFile } from "../../ingestion/documents/types.ts";

/**
 * Full text of an extracted document file: the Mongo copy when complete, the
 * S3 sidecar when the Mongo copy is truncated (DOCUMENTS_MAX_TEXT_CHARS).
 * Shared by the chunking pipeline and the full-document extraction path.
 */
export async function loadFileText(file: StoredDocumentFile): Promise<string> {
  const truncated = file.text != null && file.text.length < file.textChars;
  if (!truncated && file.text != null) return file.text;
  if (file.textS3Key) {
    const buffer = await loadDocumentFile(file.s3.bucket, file.textS3Key);
    return buffer.toString("utf8");
  }
  return file.text ?? "";
}
