/**
 * Upload limits shared by the browser and the API.
 *
 * These live outside `lib/storage/s3` because client components need them to
 * pre-validate a selection (and to build the file picker's `accept` list), and
 * importing the S3 module would drag the AWS SDK into the client bundle.
 * `lib/storage/s3` re-exports them so server code keeps one import site.
 */

/** Max size the API will mint an upload URL for (25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Content types accepted for knowledge-base document uploads. */
export const ALLOWED_DOCUMENT_CONTENT_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** Content types accepted for company logo uploads. */
export const ALLOWED_LOGO_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
] as const;

/** `accept` attribute for the document file picker. */
export const DOCUMENT_ACCEPT_ATTRIBUTE =
  ALLOWED_DOCUMENT_CONTENT_TYPES.join(",");

/**
 * Browsers leave `File.type` empty for some Office formats (and for anything
 * dragged in from an archive), which the API would reject as unsupported. Fall
 * back to the extension before giving up.
 */
const EXTENSION_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/** Best-effort content type for a picked file: its own, else its extension. */
export function resolveContentType(file: { name: string; type?: string }): string {
  const declared = file.type?.trim();
  if (declared) return declared;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_CONTENT_TYPES[extension] ?? "";
}

export type UploadRejection = "type" | "size" | "empty";

/**
 * Pre-flight check mirroring the `upload-url` route's validation so a bad file
 * in a multi-file selection fails locally instead of costing a round-trip.
 * Returns `null` when the file is acceptable.
 */
export function validateCompanyUpload(
  file: { name: string; type?: string; size: number },
  category: "logo" | (string & {}),
): UploadRejection | null {
  if (!Number.isFinite(file.size) || file.size <= 0) return "empty";
  if (file.size > MAX_UPLOAD_BYTES) return "size";
  const allowed: readonly string[] =
    category === "logo"
      ? ALLOWED_LOGO_CONTENT_TYPES
      : ALLOWED_DOCUMENT_CONTENT_TYPES;
  return allowed.includes(resolveContentType(file)) ? null : "type";
}
