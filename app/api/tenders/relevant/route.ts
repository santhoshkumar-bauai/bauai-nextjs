import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { loadCompanyDecisions } from "@/lib/tenders/decisions";
import { distanceKm, type LatLng } from "@/lib/tenders/distance";
import { parseTenderFilters } from "@/lib/tenders/filters";
import { resolveMarkerLocations } from "@/lib/tenders/geocode-cache";
import { resolveCompanyNuts } from "@/lib/tenders/nuts";
import {
  buildRelevancePipeline,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  RANK_CAP,
  type RankedTenderRaw,
} from "@/lib/tenders/relevance";
import { serializeTender } from "@/lib/tenders/serialize";
import { resolveCpvNames } from "@/lib/tenders/cpv-names";

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

  // Decisions the company already made: rejected tenders drop out of the feed,
  // pipeline ones stay but render as "In workspace" instead of offering the
  // action bar again.
  const { excludeIds, pipelineByTender } = await loadCompanyDecisions(
    String(context.company._id),
  );

  const company = context.company;
  const nuts = resolveCompanyNuts({
    region: company.region,
    regionLocation: company.regionLocation,
    addressCoordinates: company.addressCoordinates,
  });

  // Where the company sits — the anchor for both the "X km away" hint below and
  // the nearest-first ordering inside the pipeline.
  const companyLat =
    company.regionLocation?.latitude ?? company.addressCoordinates?.lat;
  const companyLng =
    company.regionLocation?.longitude ?? company.addressCoordinates?.lng;
  const companyPoint: LatLng | null =
    typeof companyLat === "number" && typeof companyLng === "number"
      ? { lat: companyLat, lng: companyLng }
      : null;

  const { pipeline } = buildRelevancePipeline(
    {
      companyCpvCodes: company.cpvCodes ?? [],
      nuts,
      countries: countries.length ? countries : undefined,
      companyPoint,
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
      sort: filters.sort,
      excludeIds,
    },
  );

  const collection = mongoDatabase.collection<TenderDocument>("tenders");
  const [facet] = await collection
    .aggregate<{ items: RankedTenderRaw[]; total: { value: number }[] }>(pipeline, {
      allowDiskUse: true,
    })
    .toArray();

  const rows = facet?.items ?? [];

  // "X km away" — resolved from coordinates the corpus already has (on the
  // tender, or warm in the shared postal cache). `allowGeocoding: false` keeps
  // this endpoint Google-free; tenders with no known point simply show no
  // distance rather than triggering a lookup per page view.
  let distances = new Map<string, number>();
  if (companyPoint) {
    const { coordinates } = await resolveMarkerLocations(
      rows.map((row) => ({
        tenderId: String(row._id),
        countryCode: row.buyer?.address?.countryCode ?? undefined,
        postalCode: row.buyer?.address?.postalCode ?? undefined,
        city: row.buyer?.address?.city ?? undefined,
        location: row.location ?? undefined,
      })),
      { allowGeocoding: false },
    );
    distances = new Map(
      [...coordinates].flatMap(([tenderId, point]) => {
        const km = distanceKm(companyPoint, point);
        return km === null ? [] : [[tenderId, km] as const];
      }),
    );
  }

  // Readable CPV category names for the card's category line — one catalog
  // lookup for the whole page, not one per tender.
  const locale = searchParams.get("locale") === "de" ? "de" : "en";
  const pageCpvCodes = [...new Set(rows.flatMap((row) => row.cpvCodes ?? []))];
  const cpvNames = await resolveCpvNames(pageCpvCodes, locale);

  const items = rows.map((row) =>
    serializeTender(row, {
      distanceKm: distances.get(String(row._id)) ?? null,
      categories: [
        ...new Set(
          (row.cpvCodes ?? []).flatMap((code) => {
            const name = cpvNames.get(code);
            return name ? [name] : [];
          }),
        ),
      ],
      pipelineStatus: pipelineByTender.get(String(row._id)) ?? null,
    }),
  );
  // `total` is every tender that matches; `rankedTotal` is how much of it is
  // actually reachable, since only the top `RANK_CAP` are ordered and paged.
  const total = facet?.total?.[0]?.value ?? 0;
  const rankedTotal = Math.min(total, RANK_CAP);

  return NextResponse.json({
    items,
    page,
    pageSize,
    total,
    rankedTotal,
    profile: {
      cpv: company.cpvCodes ?? [],
      nuts,
      region: company.region ?? null,
      hasCoordinates: companyPoint !== null,
    },
  });
}
