import { NextResponse } from "next/server";

import { ObjectId } from "mongodb";

import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import { connectMongoose } from "@/lib/db/mongoose";
import { HIDDEN_STATUSES, TenderDecision } from "@/models/tender-decision";
import type { TenderDocument } from "@/lib/ingestion/types";
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
import { CpvCode } from "@/models/cpv-code";

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
  await connectMongoose();
  const decisions = await TenderDecision.find({
    companyId: String(context.company._id),
  })
    .select({ tenderId: 1, status: 1 })
    .lean();
  const hidden = new Set<string>(HIDDEN_STATUSES);
  const excludeIds = decisions
    .filter((decision) => hidden.has(decision.status))
    .filter((decision) => ObjectId.isValid(decision.tenderId))
    .map((decision) => new ObjectId(decision.tenderId));
  const pipelineByTender = new Map(
    decisions
      .filter((decision) => !hidden.has(decision.status))
      .map((decision) => [decision.tenderId, decision.status]),
  );

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
  const companyLat =
    company.regionLocation?.latitude ?? company.addressCoordinates?.lat;
  const companyLng =
    company.regionLocation?.longitude ?? company.addressCoordinates?.lng;
  const companyPoint: LatLng | null =
    typeof companyLat === "number" && typeof companyLng === "number"
      ? { lat: companyLat, lng: companyLng }
      : null;

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
  const cpvNames = new Map<string, string>();
  if (pageCpvCodes.length) {
    const catalog = await CpvCode.find({ code: { $in: pageCpvCodes } })
      .select({ code: 1, name: 1 })
      .lean();
    for (const entry of catalog) {
      cpvNames.set(entry.code, locale === "de" ? entry.name.de : entry.name.en);
    }
  }

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
  const total = Math.min(facet?.total?.[0]?.value ?? 0, RANK_CAP);

  return NextResponse.json({
    items,
    page,
    pageSize,
    total,
    profile: {
      cpv: company.cpvCodes ?? [],
      nuts,
      region: company.region ?? null,
      hasCoordinates: companyPoint !== null,
    },
  });
}
