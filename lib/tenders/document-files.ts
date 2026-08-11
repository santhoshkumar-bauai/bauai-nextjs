import type { ObjectId } from "mongodb";

import { getIngestionDb } from "../ingestion/db/client.ts";
import type {
  StoredDocumentFile,
  TenderDocumentRecord,
} from "../ingestion/documents/types.ts";

/**
 * Read access to the FETCHED files of a tender's `tender_documents` records —
 * the actual downloaded documents in S3, as opposed to the notice's external
 * links. Powers the Documents tab file list, the file download route, and
 * Clara's list/read tools.
 */

export interface SerializedTenderFile {
  recordId: string;
  fileIndex: number;
  fileName: string;
  mimeType: string;
  byteLength: number;
  /** DONE = extracted text exists (searchable/readable by Clara). */
  textStatus: StoredDocumentFile["textStatus"];
  textChars: number;
}

function flatten(records: TenderDocumentRecord[]): SerializedTenderFile[] {
  return records.flatMap((record) =>
    record.files.map((file, fileIndex) => ({
      recordId: record._id,
      fileIndex,
      fileName: file.fileName,
      mimeType: file.mimeType,
      byteLength: file.byteLength,
      textStatus: file.textStatus,
      textChars: file.textChars,
    })),
  );
}

export async function listFetchedTenderFiles(
  tenderId: ObjectId,
): Promise<SerializedTenderFile[]> {
  const db = await getIngestionDb();
  // Not only FETCHED: a RESOLVING row carries progress snapshots (files stored
  // so far), so an in-flight fetch shows its files as they land. Matching on
  // files rather than status also keeps partial results from a failed or
  // retrying row visible — those files are already safely in S3.
  const records = await db
    .collection<TenderDocumentRecord>("tender_documents")
    .find({ tenderId, "files.0": { $exists: true } })
    .toArray();
  return flatten(records);
}

/** Resolve one stored file, validating it belongs to the given tender. */
export async function findTenderFile(
  tenderId: ObjectId,
  recordId: string,
  fileIndex: number,
): Promise<StoredDocumentFile | null> {
  const db = await getIngestionDb();
  const record = await db
    .collection<TenderDocumentRecord>("tender_documents")
    .findOne({ _id: recordId, tenderId });
  return record?.files[fileIndex] ?? null;
}

/** Case-insensitive file lookup by name across a tender's fetched records. */
export async function findTenderFileByName(
  tenderId: ObjectId,
  fileName: string,
): Promise<StoredDocumentFile | null> {
  const db = await getIngestionDb();
  const records = await db
    .collection<TenderDocumentRecord>("tender_documents")
    .find({ tenderId, status: "FETCHED" })
    .toArray();
  const wanted = fileName.trim().toLowerCase();
  for (const record of records) {
    const file = record.files.find(
      (candidate) => candidate.fileName.toLowerCase() === wanted,
    );
    if (file) return file;
  }
  return null;
}
