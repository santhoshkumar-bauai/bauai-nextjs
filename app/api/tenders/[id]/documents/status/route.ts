import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { getTenderDocumentFetchSummary } from "@/lib/tenders/document-fetch";
import { listFetchedTenderFiles } from "@/lib/tenders/document-files";

/**
 * Progress of a tender's document fetch: row counts by status plus the files
 * already stored. Polled by the Documents tab while `summary.active`, so new
 * files appear as each source completes rather than only at the end.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }
  const tenderId = new ObjectId(id);

  const tender = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: tenderId }, { projection: { isVisible: 1 } });
  if (!tender || tender.isVisible === false) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [summary, files] = await Promise.all([
    getTenderDocumentFetchSummary(tenderId),
    listFetchedTenderFiles(tenderId),
  ]);

  return NextResponse.json({ summary, files });
}
