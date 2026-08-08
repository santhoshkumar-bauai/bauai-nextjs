import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { getExtractions } from "@/lib/ai/extraction/store";
import { getCompanyContext } from "@/lib/company/context";

/** Returns the tender's extraction records with citation-verified fields. */
export async function GET(
  request: Request,
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

  const schema = new URL(request.url).searchParams.get("schema") ?? undefined;
  const records = await getExtractions(new ObjectId(id), schema);

  return NextResponse.json({
    extractions: records.map((record) => ({
      schemaName: record.schemaName,
      schemaVersion: record.schemaVersion,
      status: record.status,
      fields: record.fields,
      unresolved: record.unresolved,
      sourceDocumentRecordIds: record.sourceDocumentRecordIds,
      model: record.model,
      stats: record.stats,
      corpusHash: record.corpusHash,
      extractedAt: record.extractedAt,
    })),
  });
}
