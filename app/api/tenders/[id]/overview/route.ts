import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { RateLimitError, StructuredOutputError } from "@/lib/ai/gateway/types";
import {
  generateTenderOverview,
  getTenderOverview,
} from "@/lib/ai/overview/service";
import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { serializeTenderDetail } from "@/lib/tenders/detail";
import { aiRoleConfigured } from "@/lib/ai/gateway/config";

/**
 * Tender-centric AI overview (about / scope / buyer / risks / highlights),
 * bilingual, works with or without processed documents. GET reads the cached
 * overview; POST (re)generates inline — one model call, a few seconds.
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

  const record = await getTenderOverview(new ObjectId(id));
  return NextResponse.json({
    overview: record?.overview ?? null,
    sourceChunkCount: record?.sourceChunkCount ?? 0,
    generatedAt: record?.generatedAt ?? null,
  });
}

export async function POST(
  _request: Request,
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
    const record = await generateTenderOverview({
      tenderId,
      tender: serializeTenderDetail(doc),
    });
    return NextResponse.json({
      overview: record.overview,
      sourceChunkCount: record.sourceChunkCount,
      generatedAt: record.generatedAt,
    });
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: "AI is rate limited, try again shortly." },
        { status: 429 },
      );
    }
    if (error instanceof StructuredOutputError) {
      return NextResponse.json(
        { error: "The model returned an invalid overview." },
        { status: 502 },
      );
    }
    const message = error instanceof Error ? error.message : "Overview failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
