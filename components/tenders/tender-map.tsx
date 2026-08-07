"use client";

import {
  AdvancedMarker,
  APIProvider,
  InfoWindow,
  Map,
  useMap,
} from "@vis.gl/react-google-maps";
import { Building2, Loader2, MapPinOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import type { StatusOption } from "@/components/tenders/tender-filters";

/** Germany centroid — a sensible default before markers load and fit. */
const GERMANY_CENTER = { lat: 51.1, lng: 10.4 };

interface MapPoint {
  id: string;
  title: string | null;
  lat: number;
  lng: number;
  score: number;
  status: string;
  submissionDeadline: string | null;
  buyerName: string | null;
}

interface CompanyPoint {
  lat: number;
  lng: number;
  label: string | null;
}

const FIT_HIGH = "#059669"; // emerald
const FIT_MEDIUM = "#d97706"; // amber
const FIT_LOW = "#6b7280"; // gray

function scoreColor(score: number): string {
  if (score >= 0.66) return FIT_HIGH;
  if (score >= 0.4) return FIT_MEDIUM;
  return FIT_LOW;
}

/** Custom teardrop pin for a tender, colored by relevance and enlarged when active. */
function TenderPin({ score, active }: { score: number; active: boolean }) {
  const color = scoreColor(score);
  const size = active ? 44 : 32;
  return (
    <div
      className="origin-bottom cursor-pointer transition-transform duration-150 ease-out hover:scale-110"
      style={{ filter: "drop-shadow(0 3px 4px rgba(0,0,0,0.28))" }}
    >
      <svg
        width={size}
        height={size * 1.28}
        viewBox="0 0 32 41"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M16 1C8.27 1 2 7.27 2 15c0 9.5 12.1 23.2 13.2 24.4a1.1 1.1 0 0 0 1.6 0C17.9 38.2 30 24.5 30 15 30 7.27 23.73 1 16 1Z"
          fill={color}
          stroke="#ffffff"
          strokeWidth="2.5"
        />
        <circle cx="16" cy="15" r="5.5" fill="#ffffff" />
      </svg>
    </div>
  );
}

/** Distinct "home" pin marking the company's own location. */
function CompanyPin({ label }: { label: string }) {
  return (
    <div className="flex origin-bottom flex-col items-center">
      <div className="flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1.5 text-primary-foreground shadow-lg ring-4 ring-primary/25">
        <Building2 className="size-3.5 shrink-0" />
        <span className="max-w-[130px] truncate text-[11px] font-semibold">
          {label}
        </span>
      </div>
      <div className="-mt-1 size-2.5 rotate-45 rounded-[2px] bg-primary" />
    </div>
  );
}

/** Fits the viewport to the markers (+ company) whenever they change. */
function FitBounds({
  points,
  company,
}: {
  points: MapPoint[];
  company: CompanyPoint | null;
}) {
  const map = useMap();
  useEffect(() => {
    if (!map) return;
    const coords = [
      ...points.map((p) => ({ lat: p.lat, lng: p.lng })),
      ...(company ? [{ lat: company.lat, lng: company.lng }] : []),
    ];
    if (coords.length === 0) return;
    if (coords.length === 1) {
      map.setCenter(coords[0]);
      map.setZoom(11);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    coords.forEach((c) => bounds.extend(c));
    map.fitBounds(bounds, 72);
  }, [map, points, company]);
  return null;
}

export function TenderMap({
  filters,
  onOpenDetail,
}: {
  filters: { q: string; statuses: StatusOption[] };
  onOpenDetail?: (id: string) => void;
}) {
  const t = useTranslations("Tenders");
  const format = useFormatter();
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY;
  // Advanced (custom-HTML) markers require a Map ID; DEMO_MAP_ID works out of the
  // box, and a real styled map can be dropped in via the env var later.
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";

  const [points, setPoints] = useState<MapPoint[]>([]);
  const [company, setCompany] = useState<CompanyPoint | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.statuses.length) params.set("status", filters.statuses.join(","));
    return params.toString();
  }, [filters.q, filters.statuses]);

  useEffect(() => {
    if (!apiKey) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/tenders/relevant/geo?${queryString}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{
            points: MapPoint[];
            company: CompanyPoint | null;
          }>;
        })
        .then((json) => {
          setPoints(json.points ?? []);
          setCompany(json.company ?? null);
        })
        .catch(() => {
          if (!controller.signal.aborted) setPoints([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [apiKey, queryString]);

  if (!apiKey) {
    return (
      <div className="grid h-[560px] place-items-center rounded-xl border border-dashed border-border bg-muted/20 px-6 text-center">
        <span className="flex max-w-sm flex-col items-center gap-2 text-sm text-muted-foreground">
          <MapPinOff className="size-6" />
          {t("map.missingKey")}
        </span>
      </div>
    );
  }

  const selectedPoint = points.find((point) => point.id === selected) ?? null;

  return (
    <div className="relative h-[560px] overflow-hidden rounded-xl border border-border">
      <APIProvider apiKey={apiKey}>
        <Map
          defaultCenter={GERMANY_CENTER}
          defaultZoom={6}
          mapId={mapId}
          gestureHandling="greedy"
          disableDefaultUI={false}
          clickableIcons={false}
          streetViewControl={false}
          mapTypeControl={false}
          fullscreenControl={false}
          onClick={() => setSelected(null)}
        >
          {points.map((point) => (
            <AdvancedMarker
              key={point.id}
              position={{ lat: point.lat, lng: point.lng }}
              zIndex={point.id === selected ? 30 : 1}
              onClick={() => setSelected(point.id)}
            >
              <TenderPin score={point.score} active={point.id === selected} />
            </AdvancedMarker>
          ))}

          {company && (
            <AdvancedMarker
              position={{ lat: company.lat, lng: company.lng }}
              zIndex={40}
              title={company.label ?? t("map.you")}
            >
              <CompanyPin label={company.label ?? t("map.you")} />
            </AdvancedMarker>
          )}

          {selectedPoint && (
            <InfoWindow
              position={{ lat: selectedPoint.lat, lng: selectedPoint.lng }}
              onCloseClick={() => setSelected(null)}
              pixelOffset={[0, -44]}
            >
              <div className="flex max-w-[230px] flex-col gap-1 p-1">
                <strong className="text-xs text-neutral-900">
                  {selectedPoint.title ?? "—"}
                </strong>
                {selectedPoint.buyerName && (
                  <span className="text-[11px] text-neutral-600">
                    {selectedPoint.buyerName}
                  </span>
                )}
                <span className="text-[11px] text-neutral-600">
                  {t("card.match", { percent: Math.round(selectedPoint.score * 100) })}
                  {" · "}
                  {t(`status.${selectedPoint.status}` as "status.OPEN", {})}
                </span>
                {selectedPoint.submissionDeadline && (
                  <span className="text-[11px] text-neutral-600">
                    {t("card.deadline")}:{" "}
                    {format.dateTime(new Date(selectedPoint.submissionDeadline), {
                      dateStyle: "medium",
                    })}
                  </span>
                )}
                {onOpenDetail && (
                  <button
                    type="button"
                    onClick={() => onOpenDetail(selectedPoint.id)}
                    className="mt-1 self-start rounded-md bg-neutral-900 px-2 py-1 text-[11px] font-medium text-white hover:bg-neutral-700"
                  >
                    {t("map.viewDetails")}
                  </button>
                )}
              </div>
            </InfoWindow>
          )}

          <FitBounds points={points} company={company} />
        </Map>
      </APIProvider>

      {loading && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/40">
          <span className="flex items-center gap-2 rounded-full bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("map.loading")}
          </span>
        </div>
      )}

      {!loading && points.length === 0 && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="rounded-full bg-background px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            {t("map.noPoints")}
          </span>
        </div>
      )}

      {/* Legend */}
      <div className="pointer-events-none absolute top-2 left-2 flex flex-col gap-1 rounded-lg border border-border bg-background/90 px-2.5 py-2 text-[10px] shadow-sm backdrop-blur">
        <span className="font-semibold text-foreground">{t("map.legend.title")}</span>
        <LegendRow color={FIT_HIGH} label={t("map.legend.high")} />
        <LegendRow color={FIT_MEDIUM} label={t("map.legend.medium")} />
        <LegendRow color={FIT_LOW} label={t("map.legend.low")} />
        <span className="mt-0.5 flex items-center gap-1.5 border-t border-border pt-1 text-muted-foreground">
          <span className="grid size-2.5 place-items-center rounded-full bg-primary" />
          {t("map.legend.company")}
        </span>
      </div>

      <div className="pointer-events-none absolute right-2 bottom-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {t("map.attribution")}
      </div>
    </div>
  );
}

function LegendRow({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span
        className="size-2.5 rounded-full ring-1 ring-black/10"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  );
}
