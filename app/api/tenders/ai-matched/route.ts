import { NextResponse } from "next/server";

import { ObjectId } from "mongodb";

import { aiEnv } from "@/lib/ai/config/env";
import { profileCoverage, getMatchProfileState } from "@/lib/ai/match/company-profile";
import { runMatchFeed } from "@/lib/ai/match/feed";
import { getRun, serializeRun } from "@/lib/ai/match/runs";
import { getCompanyContext } from "@/lib/company/context";
import { resolveCpvNames } from "@/lib/tenders/cpv-names";
import { loadCompanyDecisions } from "@/lib/tenders/decisions";
import { distanceKm, type LatLng } from "@/lib/tenders/distance";
import { parseTenderFilters } from "@/lib/tenders/filters";
import { resolveMarkerLocations } from "@/lib/tenders/geocode-cache";
import { resolveCompanyNuts } from "@/lib/tenders/nuts";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@/lib/tenders/relevance";
import { serializeTender } from "@/lib/tenders/serialize";

/**
 * The AI Matched feed: tenders ranked by semantic fit against the company's
 * whole profile and document corpus, blended with the deterministic CPV/geo/
 * time signals.
 *
 * Serves persisted rows only — the expensive part runs in the background
 * refresh. This endpoint never blocks on it, so a company whose matches are
 * still computing gets stages and (if it has them) the previous run's results
 * rather than a spinner.
 */

export type MatchFeedState =
  | "ready"
  | "stale"
  | "computing"
  | "never"
  | "empty"
  | "unavailable";

export async function GET(request: Request) {
  const context = await getCompanyContext();
  if (!context) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const env = aiEnv();
  const { searchParams } = new URL(request.url);
  const locale = searchParams.get("locale") === "de" ? "de" : "en";

  const company = context.company;
  const nuts = resolveCompanyNuts({
    region: company.region,
    regionLocation: company.regionLocation,
    addressCoordinates: company.addressCoordinates,
  });
  const profileBlock = {
    cpv: company.cpvCodes ?? [],
    nuts,
    region: company.region ?? null,
    hasCoordinates:
      typeof (company.regionLocation?.latitude ?? company.addressCoordinates?.lat) ===
      "number",
  };

  const empty = (state: MatchFeedState, extra: Record<string, unknown> = {}) =>
    NextResponse.json({
      state,
      run: null,
      items: [],
      page: 0,
      pageSize: DEFAULT_PAGE_SIZE,
      total: 0,
      rankedTotal: 0,
      coverage: null,
      profile: profileBlock,
      ...extra,
    });

  // Kill switch — the tab hides itself and the client falls back to classic.
  if (!env.matchEnabled) return empty("unavailable");

  const tenantId = new ObjectId(String(company._id));
  const page = Math.max(0, Number.parseInt(searchParams.get("page") ?? "0", 10) || 0);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(
      1,
      Number.parseInt(searchParams.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10) ||
        DEFAULT_PAGE_SIZE,
    ),
  );
  const filters = parseTenderFilters(searchParams);

  const [run, profileState, decisions] = await Promise.all([
    getRun(tenantId),
    getMatchProfileState(tenantId),
    loadCompanyDecisions(String(company._id)),
  ]);

  const coverage = profileCoverage(profileState.profile);
  const runState = run ? serializeRun(run) : null;

  // Nothing has ever completed: report the run (if one is live) so the client
  // can render stages, but there is nothing to page through yet.
  if (!run?.lastCompletedRunId) {
    const state: MatchFeedState =
      run?.status === "running"
        ? "computing"
        : run?.status === "failed" && run.error === "search_unavailable"
          ? "unavailable"
          : "never";
    return empty(state, { run: runState, coverage });
  }

  const { rows, total } = await runMatchFeed({
    tenantId,
    runId: run.lastCompletedRunId,
    filters,
    page,
    pageSize,
    now: new Date(),
    excludeIds: decisions.excludeIds,
  });

  // Results exist, so serve them regardless of what else is true. A refresh
  // being needed (or in flight) is a banner, never an empty page.
  const state: MatchFeedState =
    run.status === "running"
      ? "computing"
      : profileState.stale || run.companyDataHash !== profileState.companyDataHash
        ? "stale"
        : total === 0
          ? "empty"
          : "ready";

  const companyLat =
    company.regionLocation?.latitude ?? company.addressCoordinates?.lat;
  const companyLng =
    company.regionLocation?.longitude ?? company.addressCoordinates?.lng;
  const companyPoint: LatLng | null =
    typeof companyLat === "number" && typeof companyLng === "number"
      ? { lat: companyLat, lng: companyLng }
      : null;

  // Same Google-free distance hints as the classic feed.
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
      pipelineStatus: decisions.pipelineByTender.get(String(row._id)) ?? null,
      aiMatch: {
        matchScore: row.match.matchScore,
        fitScore: row.match.fitScore,
        confidence: row.match.confidence,
        // Both languages are generated in one pass; pick here so the client
        // never has to know the reason was bilingual.
        reason: row.match.reasons ? row.match.reasons[locale] : null,
        matchedCapabilities: row.match.matchedCapabilities,
        concerns: row.match.concerns,
        signals: {
          semantic: row.match.signals.semantic,
          cpv: row.match.signals.cpv,
          geo: row.match.signals.geo,
          time: row.match.signals.time,
        },
        matchedOn: row.match.matchedFacets.map((facet) => ({
          label: facet.label,
          key: facet.key,
          kind: facet.kind,
        })),
        computedAt: new Date(row.match.computedAt).toISOString(),
      },
    }),
  );

  return NextResponse.json({
    state,
    run: runState,
    items,
    page,
    pageSize,
    total,
    // Everything scored is pageable here — unlike the classic feed there is no
    // larger unranked remainder behind the cap.
    rankedTotal: total,
    coverage,
    profile: profileBlock,
  });
}
