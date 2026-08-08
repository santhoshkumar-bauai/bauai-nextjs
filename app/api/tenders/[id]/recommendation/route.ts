import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getGateway } from "@/lib/ai/gateway";
import { RateLimitError, StructuredOutputError } from "@/lib/ai/gateway/types";
import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { serializeTenderDetail } from "@/lib/tenders/detail";
import {
  buildRecommendationPrompt,
  normalizeRecommendation,
  RECOMMENDATION_SCHEMA,
  type CompanyProfileForAI,
} from "@/lib/tenders/recommendation";

/**
 * On-demand AI fit analysis for a tender vs. the caller's company. Triggered
 * explicitly from the detail modal's recommendation tab — never runs as part
 * of listing. Model access goes through the AI gateway ("reasoning" role).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (!process.env.GEMINI_API_KEY) {
    return NextResponse.json({ error: "Gemini is not configured." }, { status: 503 });
  }

  const { id } = await params;
  if (!ObjectId.isValid(id)) {
    return NextResponse.json({ error: "Invalid tender id" }, { status: 400 });
  }

  const doc = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .findOne({ _id: new ObjectId(id) });
  if (!doc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const tender = serializeTenderDetail(doc);
  const company = context.company;
  const profile: CompanyProfileForAI = {
    name: company.name,
    businessDomain: company.businessDomain,
    region: company.region,
    services: company.services,
    cpvCodes: company.cpvCodes,
    trade: company.trade,
    specializations: company.specializations,
    certifications: company.certifications,
    employeeCount: company.employeeCount ?? null,
    projectSizeRange: company.projectSizeRange ?? null,
    capabilities:
      company.knowledgeBase?.technicalNarratives?.capabilitiesStatement ?? null,
  };

  const locale =
    new URL(request.url).searchParams.get("locale") === "de" ? "de" : "en";
  const prompt = buildRecommendationPrompt({ company: profile, tender, locale });

  try {
    const result = await getGateway().generateStructured({
      role: "reasoning",
      prompt,
      schema: RECOMMENDATION_SCHEMA as unknown as Record<string, unknown>,
      // The battle-tested normalizer below owns semantic validation; zod only
      // guards the transport shape here.
      zod: z.record(z.string(), z.unknown()),
    });

    const recommendation = normalizeRecommendation(result.value);
    if (!recommendation) {
      return NextResponse.json(
        { error: "Gemini returned an incomplete recommendation." },
        { status: 502 },
      );
    }

    return NextResponse.json({ recommendation, model: result.model });
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
