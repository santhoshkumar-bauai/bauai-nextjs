import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import { loadDocumentFile } from "@/lib/ingestion/documents/store";
import type { TenderDocument } from "@/lib/ingestion/types";
import { findTenderFile } from "@/lib/tenders/document-files";

/**
 * Streams one downloaded tender file (tender_documents → S3) to the browser.
 * The bytes go through the API rather than a presigned URL because tender
 * files live in the ingestion bucket, addressed by per-file bucket+key —
 * no client-facing credentials or bucket layout leak.
 * Query: ?record={tender_documents._id}&file={index}
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }
  const url = new URL(request.url);
  const recordId = url.searchParams.get("record");
  const fileIndex = Number(url.searchParams.get("file"));
  if (!recordId || !Number.isInteger(fileIndex) || fileIndex < 0) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const tenderId = new ObjectId(id);
  const tender = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: tenderId }, { projection: { isVisible: 1 } });
  if (!tender || tender.isVisible === false) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // findTenderFile validates the record belongs to THIS tender.
  const file = await findTenderFile(tenderId, recordId, fileIndex);
  if (!file) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const bytes = await loadDocumentFile(file.s3.bucket, file.s3.key);
  const asciiName = file.fileName.replace(/[^\x20-\x7e]+/g, "_").replace(/"/g, "");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": file.mimeType || "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      "cache-control": "private, max-age=3600",
    },
  });
}
