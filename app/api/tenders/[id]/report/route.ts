import { ObjectId } from "mongodb";
import { NextResponse, after } from "next/server";

import { runReportJob } from "@/lib/ai/report/job";
import { claimRun, getRun, serializeRun } from "@/lib/ai/report/runs";
import { getReportState, serializeReport } from "@/lib/ai/report/service";
import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { serializeTenderDetail } from "@/lib/tenders/detail";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { reportLocaleFromRequest } from "./locale";
import { aiProviderConfigured } from "@/lib/ai/gateway/config";

/**
 * The full tender report — the deepest artifact the product produces.
 *
 * GET returns the cached report in the caller's language plus the state of any
 * generation in flight. POST claims a run and returns immediately; the work
 * continues past the response (`after`) and records its progress in the run
 * document, so a reader who reloads, closes the tab, or opens a second one
 * rejoins the same generation instead of losing it or starting a duplicate.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 800;

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
  const tenderId = new ObjectId(id);
  const tenantId = forCompanyContext(context).value;

  const [state, run] = await Promise.all([
    getReportState(context, tenderId),
    getRun(tenantId, tenderId),
  ]);

  return NextResponse.json({
    report: state
      ? serializeReport(state.report, state.stale, reportLocaleFromRequest(request))
      : null,
    run: run ? serializeRun(run) : null,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (
    !aiProviderConfigured()
  ) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }
  const tenderId = new ObjectId(id);
  const tenantId = forCompanyContext(context).value;

  const doc = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: tenderId });
  if (!doc || doc.isVisible === false) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The analysis is reasoned in the caller's working language and translated
  // into the other, so a German user's report is written in German.
  const locale = reportLocaleFromRequest(request);
  const claimed = await claimRun({
    tenantId,
    tenderId,
    locale,
    userId: context.userId,
  });

  if (!claimed) {
    // Someone else is already generating this exact report. Report their run
    // rather than paying for a second one.
    const existing = await getRun(tenantId, tenderId);
    return NextResponse.json(
      { run: existing ? serializeRun(existing) : null, joined: true },
      { status: 202 },
    );
  }

  // Survives the response: the reader is free to navigate away.
  after(() =>
    runReportJob({
      companyContext: context,
      tenantId,
      tenderId,
      tender: serializeTenderDetail(doc),
      locale,
    }),
  );

  return NextResponse.json(
    { run: serializeRun(claimed), joined: false },
    { status: 202 },
  );
}
