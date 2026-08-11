import { ObjectId } from "mongodb";
import { after, NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import {
  prepareTenderDocumentFetch,
  runTenderDocumentFetch,
} from "@/lib/tenders/document-fetch";

/**
 * Starts an on-demand document fetch for one tender — the "Fetch documents"
 * button. Requeues the tender's retriable `tender_documents` rows and drains
 * them via `after()`, so the button works with no document worker running
 * (the same tradeoff the AI match refresh route makes). Progress is read from
 * the sibling `documents/status` route.
 *
 * Idempotent under double-clicks: rows are claimed atomically, so concurrent
 * runs split the work instead of duplicating it.
 */

export const maxDuration = 300;

export async function POST(
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

  const summary = await prepareTenderDocumentFetch(tenderId);
  if (!summary.active) {
    // Nothing retriable: no document sources, or only restricted/login-walled
    // ones. The client shows the current state rather than a progress bar.
    return NextResponse.json({ started: false, summary });
  }

  // Survives the response: the user is free to navigate away and come back.
  after(() => runTenderDocumentFetch(tenderId));

  return NextResponse.json({ started: true, summary }, { status: 202 });
}
