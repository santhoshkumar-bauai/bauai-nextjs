import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getGateway } from "@/lib/ai/gateway";
import { RateLimitError, StructuredOutputError } from "@/lib/ai/gateway/types";
import { auth } from "@/lib/auth";
import { connectMongoose } from "@/lib/db/mongoose";
import { CpvCode } from "@/models/cpv-code";

type MappingBody = {
  services?: unknown;
  businessDomain?: unknown;
  locale?: unknown;
};

const cleanServices = (value: unknown) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string")
            .map((item) => item.trim())
            .filter(Boolean),
        ),
      ].slice(0, 20)
    : [];

async function findCandidates(services: string[], businessDomain: string) {
  const search = services.join(" ");
  const primaryFilter: Record<string, unknown> = { $text: { $search: search } };
  if (businessDomain) primaryFilter.categories = businessDomain;

  const primary = await CpvCode.find(primaryFilter, {
    _id: 0,
    code: 1,
    name: 1,
    keywords: 1,
    score: { $meta: "textScore" },
  })
    .sort({ score: { $meta: "textScore" } })
    .limit(120)
    .lean();

  if (primary.length >= 40) return primary;

  const fallbackFilter: Record<string, unknown> = businessDomain
    ? { categories: businessDomain, hierarchyLevel: { $lte: 5 } }
    : { hierarchyLevel: { $lte: 3 } };
  const fallback = await CpvCode.find(fallbackFilter)
    .sort({ code: 1 })
    .limit(120 - primary.length)
    .select({ _id: 0, code: 1, name: 1, keywords: 1 })
    .lean();

  const unique = new Map(
    [...primary, ...fallback].map((item) => [item.code, item]),
  );
  return [...unique.values()].slice(0, 120);
}

export async function POST(request: Request) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.emailVerified) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return NextResponse.json(
      { error: "Gemini is not configured." },
      { status: 503 },
    );

  const body = (await request.json()) as MappingBody;
  const selectedServices = cleanServices(body.services);
  const businessDomain =
    typeof body.businessDomain === "string"
      ? body.businessDomain.trim().toUpperCase()
      : "";
  const locale = body.locale === "de" ? "de" : "en";
  if (!selectedServices.length) {
    return NextResponse.json(
      { error: "Add at least one service first." },
      { status: 400 },
    );
  }

  await connectMongoose();
  const candidates = await findCandidates(selectedServices, businessDomain);

  if (!candidates.length) {
    return NextResponse.json(
      { error: "CPV catalog is empty. Run npm run db:seed:cpv." },
      { status: 503 },
    );
  }

  const candidateText = candidates
    .map(
      (item) =>
        `${item.code} | ${item.name.en} | ${item.name.de} | ${(item.keywords || []).join(", ")}`,
    )
    .join("\n");
  const prompt = [
    "Map the company's services to the most relevant EU Common Procurement Vocabulary (CPV) codes.",
    "Select only codes from the supplied catalog. Prefer precise codes over broad parent codes.",
    "Return between 3 and 10 codes, avoid redundant parent/child choices unless both are genuinely useful.",
    `Company domain: ${businessDomain || "unspecified"}`,
    `Services: ${selectedServices.join(", ")}`,
    "Catalog:",
    candidateText,
  ].join("\n");
  let requestedCodes: string[] = [];
  let model = "";
  try {
    const result = await getGateway().generateStructured({
      role: "extraction",
      prompt,
      schema: {
        type: "object",
        properties: {
          codes: {
            type: "array",
            minItems: 1,
            maxItems: 10,
            items: {
              type: "string",
              enum: candidates.map((item) => item.code),
            },
          },
        },
        required: ["codes"],
        additionalProperties: false,
      },
      zod: z.object({ codes: z.array(z.string()) }),
    });
    requestedCodes = result.value.codes;
    model = result.model;
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { error: "AI is rate limited, try again shortly." },
        { status: 429 },
      );
    }
    if (error instanceof StructuredOutputError) {
      return NextResponse.json(
        { error: "Gemini returned an invalid mapping." },
        { status: 502 },
      );
    }
    const message = error instanceof Error ? error.message : "AI mapping failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const allowed = new Map(candidates.map((item) => [item.code, item]));
  const items = [...new Set(requestedCodes)].flatMap((code) => {
    const item = allowed.get(code);
    return item
      ? [
          {
            value: code,
            label: `${code} - ${locale === "de" ? item.name.de : item.name.en}`,
          },
        ]
      : [];
  });
  if (!items.length)
    return NextResponse.json(
      { error: "No relevant CPV codes were found." },
      { status: 422 },
    );

  return NextResponse.json({ items, model });
}
