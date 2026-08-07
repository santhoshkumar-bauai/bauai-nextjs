import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { resolveCompanyNuts } from "@/lib/tenders/nuts";
import {
  buildRelevancePipeline,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  OPPORTUNITY_STATUSES,
  RANK_CAP,
  type RankedTenderRaw,
} from "@/lib/tenders/relevance";
import { serializeTender } from "@/lib/tenders/serialize";

/**
 * Ranked, most-relevant-first tenders for the authenticated company.
 *
 * Scores on CPV/sector fit + NUTS-tier proximity + recency/urgency. Uses only
 * data already present in the corpus — no geocoding, no Google calls (that lives
 * in the sibling `/geo` route for the map). Route Handlers are uncached by
 * default in this Next.js build, and the response is per-company, so no cache
 * opt-out export is needed.
 */

function parseList(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function GET(request: Request) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) ||
        DEFAULT_PAGE_SIZE,
    ),
  );
  const countries = parseList(searchParams.get("country")).map((c) => c.toUpperCase());
  const statuses = parseList(searchParams.get("status"))
    .map((s) => s.toUpperCase())
    .filter((s) => (OPPORTUNITY_STATUSES as readonly string[]).includes(s));
  const q = searchParams.get("q")?.trim().slice(0, 120) || undefined;
  const minScoreParam = searchParams.get("minScore");
  const minScore = minScoreParam != null ? Number.parseFloat(minScoreParam) : undefined;

  const company = context.company;
  const nuts = resolveCompanyNuts({
    region: company.region,
    regionLocation: company.regionLocation,
    addressCoordinates: company.addressCoordinates,
  });

  const { pipeline } = buildRelevancePipeline(
    {
      companyCpvCodes: company.cpvCodes ?? [],
      nuts,
      countries: countries.length ? countries : undefined,
    },
    {
      now: new Date(),
      page,
      pageSize,
      statuses: statuses.length ? statuses : undefined,
      q,
      minScore: Number.isFinite(minScore) ? minScore : undefined,
    },
  );

  const collection = mongoDatabase.collection<TenderDocument>("tenders");
  const [facet] = await collection
    .aggregate<{ items: RankedTenderRaw[]; total: { value: number }[] }>(pipeline, {
      allowDiskUse: true,
    })
    .toArray();

  const items = (facet?.items ?? []).map(serializeTender);
  const total = Math.min(facet?.total?.[0]?.value ?? 0, RANK_CAP);

  return NextResponse.json({
    items,
    page,
    pageSize,
    total,
    profile: {
      cpv: company.cpvCodes ?? [],
      nuts,
    },
  });
}
