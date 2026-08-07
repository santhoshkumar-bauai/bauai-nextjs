import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

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

type GeminiResponse = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  error?: { message?: string };
};

/**
 * On-demand AI fit analysis for a tender vs. the caller's company (Gemini).
 * Triggered explicitly from the detail modal's recommendation tab — never runs
 * as part of listing. Reuses the Gemini REST pattern from `app/api/cpv-map`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
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
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: RECOMMENDATION_SCHEMA,
        },
      }),
      cache: "no-store",
    },
  );

  const data = (await response.json()) as GeminiResponse;
  if (!response.ok) {
    return NextResponse.json(
      { error: data.error?.message || "AI recommendation failed." },
      { status: 502 },
    );
  }

  const text =
    data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") ||
    "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return NextResponse.json(
      { error: "Gemini returned an invalid recommendation." },
      { status: 502 },
    );
  }

  const recommendation = normalizeRecommendation(parsed);
  if (!recommendation) {
    return NextResponse.json(
      { error: "Gemini returned an incomplete recommendation." },
      { status: 502 },
    );
  }

  return NextResponse.json({ recommendation, model });
}
