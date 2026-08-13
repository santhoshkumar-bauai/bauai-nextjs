/**
 * Works out which legacy files belong to a company, and where their bytes live.
 *
 * `extracted_document.storage_path` is not one format but three things at once,
 * which is the whole difficulty here:
 *
 *   1. a full public URL into `GAigentFiles` — genuine company documents
 *      (reference projects, capability statements) uploaded to the profile
 *   2. a bucket-relative `<companyId>/<docId>/<name>` path into
 *      `chat-attachments` — files a user dropped into a conversation, which in
 *      this data are almost always tender documents belonging to someone else's
 *      procurement rather than to the company
 *   3. rows whose mime type is XML — eForms notices the old system extracted
 *      text from, not uploads at all
 *
 * Treating all three as "company documents" would fill the new knowledge base
 * with other people's tender paperwork, which the profile auto-fill and Clara's
 * company search both read from. So they are classified, not lumped together.
 *
 * Pure: the script does the downloading and uploading.
 */

/** Bucket holding files referenced by a bucket-relative storage_path. */
export const RELATIVE_PATH_BUCKET = "chat-attachments";

export interface LegacyDocumentRow {
  id: string;
  company_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  file_size: number | string | null;
  storage_path: string | null;
}

export interface StorageRef {
  bucket: string;
  /** Object path within the bucket, unencoded. */
  objectPath: string;
}

/**
 * Resolves either storage_path form to a bucket and object path.
 *
 * A stored URL keeps its own bucket; a bare path is relative to
 * `RELATIVE_PATH_BUCKET`, which is where those objects actually live.
 */
export function parseStoragePath(
  storagePath: string | null | undefined,
): StorageRef | null {
  const raw = storagePath?.trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    // .../storage/v1/object/public/<bucket>/<path> — `public/` is optional.
    const match = raw.match(/\/object\/(?:public\/|sign\/|authenticated\/)?([^/]+)\/(.+)$/);
    if (!match) return null;
    let objectPath: string;
    try {
      objectPath = decodeURIComponent(match[2].split("?")[0]);
    } catch {
      objectPath = match[2].split("?")[0];
    }
    return { bucket: match[1], objectPath };
  }

  const cleaned = raw.replace(/^\/+/, "");
  // A trailing slash is a folder, not a file — `documents` contains a few.
  if (!cleaned || cleaned.endsWith("/")) return null;
  return { bucket: RELATIVE_PATH_BUCKET, objectPath: cleaned };
}

export type DocumentKind = "company-document" | "chat-attachment" | "tender-artifact";

/**
 * Sorts a legacy row by what it actually is. XML is checked first: a tender
 * notice stored under a company folder is still a tender notice.
 */
export function classifyDocument(row: LegacyDocumentRow): DocumentKind {
  const mime = String(row.mime_type ?? "").toLowerCase();
  const name = String(row.file_name ?? "").toLowerCase();
  if (mime.includes("xml") || name.endsWith(".xml")) return "tender-artifact";

  const ref = parseStoragePath(row.storage_path);
  if (!ref) return "tender-artifact";
  return ref.bucket === RELATIVE_PATH_BUCKET ? "chat-attachment" : "company-document";
}

/**
 * Files the new model recognises. Everything migrated lands in `general`: it is
 * the bucket the profile auto-fill reads, and the legacy data carries no
 * reliable signal for the narrower categories (`insurances` and the
 * certification/reference arrays were empty across the whole cohort).
 */
export type CompanyFileCategory =
  | "logo"
  | "insurance"
  | "certification"
  | "reference-project"
  | "general";

export interface PlannedFile {
  legacyId: string;
  legacyCompanyId: string;
  fileName: string;
  contentType: string;
  size: number;
  ref: StorageRef;
  category: CompanyFileCategory;
  kind: DocumentKind;
}

const FALLBACK_CONTENT_TYPE = "application/octet-stream";

export function planFile(
  row: LegacyDocumentRow,
  options: { category?: CompanyFileCategory } = {},
): PlannedFile | null {
  const ref = parseStoragePath(row.storage_path);
  if (!ref || !row.company_id) return null;

  // The object path always ends in the real filename; `file_name` is sometimes
  // missing and sometimes a display label.
  const fromPath = ref.objectPath.split("/").pop() ?? "";
  const fileName = (row.file_name?.trim() || fromPath).slice(0, 200);
  if (!fileName) return null;

  return {
    legacyId: row.id,
    legacyCompanyId: row.company_id,
    fileName,
    contentType: row.mime_type?.trim() || FALLBACK_CONTENT_TYPE,
    size: Number(row.file_size) || 0,
    ref,
    category: options.category ?? "general",
    kind: classifyDocument(row),
  };
}

/**
 * Drops files the same company would receive twice. The legacy tables hold one
 * row per extraction attempt, so the same object can appear several times.
 */
export function dedupePlannedFiles(files: PlannedFile[]): PlannedFile[] {
  const byObject = new Map<string, PlannedFile>();
  for (const file of files) {
    const key = `${file.legacyCompanyId}|${file.ref.bucket}|${file.ref.objectPath}`;
    if (!byObject.has(key)) byObject.set(key, file);
  }
  return [...byObject.values()];
}
