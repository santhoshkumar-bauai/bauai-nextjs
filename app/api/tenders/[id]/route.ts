import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import { connectMongoose } from "@/lib/db/mongoose";
import type { TenderDocument } from "@/lib/ingestion/types";
import { serializeTenderDetail } from "@/lib/tenders/detail";
import { listFetchedTenderFiles } from "@/lib/tenders/document-files";
import { TenderDecision } from "@/models/tender-decision";

/**
 * Full detail for a single tender, powering the detail modal and the full-page
 * view. Gated to authenticated company members; `params` is a Promise in this
 * Next.js build.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }

  const doc = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: new ObjectId(id) });

  if (!doc || doc.isVisible === false) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The downloaded document files (tender_documents/S3), distinct from the
  // notice's external links — the Documents tab shows both.
  const files = await listFetchedTenderFiles(doc._id!).catch(() => []);

  // This company's own decision, so the detail view can offer "To Workspace" /
  // "Reject" or report where the tender already sits.
  await connectMongoose();
  const decision = await TenderDecision.findOne({
    companyId: String(context.company._id),
    tenderId: id,
  })
    .select({ status: 1 })
    .lean();

  return NextResponse.json({
    tender: serializeTenderDetail(doc),
    files,
    decision: decision?.status ?? null,
  });
}
