import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { parseTenderFilters } from "@/lib/tenders/filters";
import { resolveCompanyNuts } from "@/lib/tenders/nuts";
import {
  buildRelevancePipeline,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RANK_CAP,
  type RankedTenderRaw,
} from "@/lib/tenders/relevance";
import { serializeTender } from "@/lib/tenders/serialize";

/**
 * Ranked, most-relevant-first tenders for the authenticated company, with hard
 * filters (status, contract type, sector, region, deadline, min match). Uses
 * only data already present in the corpus — no geocoding, no Google calls.
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
  const filters = parseTenderFilters(searchParams);

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
      statuses: filters.statuses.length ? filters.statuses : undefined,
      q: filters.q,
      minScore: filters.minScore,
      contractNatures: filters.contractNatures.length
        ? filters.contractNatures
        : undefined,
      sectors: filters.sectors.length ? filters.sectors : undefined,
      regions: filters.regions.length ? filters.regions : undefined,
      deadlineInDays: filters.deadlineInDays,
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
