import { NextResponse } from "next/server";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import type { TenderDocument } from "@/lib/ingestion/types";
import { parseTenderFilters } from "@/lib/tenders/filters";
import {
  resolveMarkerLocations,
  type MarkerInput,
} from "@/lib/tenders/geocode-cache";
import { resolveCompanyNuts } from "@/lib/tenders/nuts";
import {
  buildGeoPipeline,
  MARKER_CAP,
  type RankedGeoRaw,
} from "@/lib/tenders/relevance";

/**
 * Map markers for the authenticated company's most relevant tenders. This is
 * the ONLY endpoint that lazily geocodes (and caches) — the list endpoint stays
 * Google-free. Ranks the same way as `/api/tenders/relevant`, takes the top
 * `MARKER_CAP`, then resolves coordinates via the shared postal-key cache.
 */

export async function GET(request: Request) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const filters = parseTenderFilters(searchParams);
  const limit = Math.min(
    MARKER_CAP,
    Math.max(1, Number.parseInt(searchParams.get("limit") ?? String(MARKER_CAP), 10) || MARKER_CAP),
  );

  const company = context.company;
  const nuts = resolveCompanyNuts({
    region: company.region,
    regionLocation: company.regionLocation,
    addressCoordinates: company.addressCoordinates,
  });

  const { pipeline } = buildGeoPipeline(
    { companyCpvCodes: company.cpvCodes ?? [], nuts },
    {
      now: new Date(),
      statuses: filters.statuses.length ? filters.statuses : undefined,
      q: filters.q,
      minScore: filters.minScore,
      contractNatures: filters.contractNatures.length ? filters.contractNatures : undefined,
      sectors: filters.sectors.length ? filters.sectors : undefined,
      regions: filters.regions.length ? filters.regions : undefined,
      deadlineInDays: filters.deadlineInDays,
      markerCap: limit,
    },
  );

  const rows = await mongoDatabase
    .collection<TenderDocument>("tenders")
    .aggregate<RankedGeoRaw>(pipeline, { allowDiskUse: true })
    .toArray();

  const markerInputs: MarkerInput[] = rows.map((row) => ({
    tenderId: String(row._id),
    countryCode: row.countryCode,
    postalCode: row.postalCode,
    city: row.city,
    location: row.location,
  }));

  const { coordinates, stats } = await resolveMarkerLocations(markerInputs);

  const companyLat =
    company.regionLocation?.latitude ?? company.addressCoordinates?.lat;
  const companyLng =
    company.regionLocation?.longitude ?? company.addressCoordinates?.lng;
  const companyPoint =
    typeof companyLat === "number" && typeof companyLng === "number"
      ? { lat: companyLat, lng: companyLng, label: company.name ?? null }
      : null;

  const points = rows
    .map((row) => {
      const point = coordinates.get(String(row._id));
      if (!point) return null;
      return {
        id: String(row._id),
        title: row.title,
        lat: point.lat,
        lng: point.lng,
        score: Math.round((row.score ?? 0) * 1000) / 1000,
        status: row.status,
        submissionDeadline: row.submissionDeadline
          ? new Date(row.submissionDeadline).toISOString()
          : null,
        buyerName: row.buyerName ?? null,
      };
    })
    .filter((point): point is NonNullable<typeof point> => point !== null);

  return NextResponse.json({ points, stats, company: companyPoint });
}
