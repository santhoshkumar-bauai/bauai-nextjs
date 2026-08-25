import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { generateFit, getFitState } from "@/lib/ai/fit/service";
import { RateLimitError, StructuredOutputError } from "@/lib/ai/gateway/types";
import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import type { TenderDocument } from "@/lib/ingestion/types";
import { serializeTenderDetail } from "@/lib/tenders/detail";
import { aiRoleConfigured } from "@/lib/ai/gateway/config";

/**
 * Company-fit analysis for a tender. GET returns the cached, tenant-scoped
 * recommendation with a staleness flag (company data changed since it was
 * generated); POST (re)generates using the full company context — profile,
 * embedded company-document evidence, and citation-verified tender facts.
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

  const state = await getFitState(context, new ObjectId(id));
  return NextResponse.json({
    recommendation: state.recommendation,
    stale: state.stale,
    generatedAt: state.generatedAt,
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

  if (!aiRoleConfigured("reasoning")) {
    return NextResponse.json({ error: "No AI provider is configured." }, { status: 503 });
  }

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }
  const tenderId = new ObjectId(id);

  const doc = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: tenderId });
  if (!doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const recommendation = await generateFit({
      context,
      tenderId,
      tender: serializeTenderDetail(doc),
      locale: resolveRequestLocale(request),
    });
    return NextResponse.json({ recommendation, stale: false });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: "AI is rate limited, try again shortly." },
        { status: 429 },
      );
    }
    if (error instanceof StructuredOutputError) {
      return NextResponse.json(
        { error: "Gemini returned an invalid recommendation." },
        { status: 502 },
      );
    }
    const message =
      error instanceof Error ? error.message : "AI recommendation failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
