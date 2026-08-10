import { NextResponse } from "next/server";

import { ObjectId } from "mongodb";

import { getRun, serializeRun } from "@/lib/ai/match/runs";
import { getCompanyContext } from "@/lib/company/context";

/**
 * Progress poll for a match refresh. Deliberately tiny — the progress panel
 * hits this every few seconds while a run is live, and re-fetching the whole
 * feed for a stage change would be wasteful.
 *
 * Polling rather than SSE: the payload is a handful of fields and the run
 * lives in Mongo, so a reload resumes for free with no reconnection logic.
 */
export async function GET() {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const run = await getRun(new ObjectId(String(context.company._id)));
  return NextResponse.json({ run: run ? serializeRun(run) : null });
}
