"use client";

import {
  AdvancedMarker,
  APIProvider,
  InfoWindow,
  Map,
  Marker,
  Pin,
  useMap,
} from "@vis.gl/react-google-maps";
import { Loader2, MapPinOff } from "lucide-react";
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

function scoreColor(score: number): string {
  if (score >= 0.66) return "#059669"; // emerald
  if (score >= 0.4) return "#d97706"; // amber
  return "#6b7280"; // gray
}

/** Fits the map viewport to the current markers whenever they change. */
function FitBounds({ points }: { points: MapPoint[] }) {
  const map = useMap();
  useEffect(() => {
    if (!map || points.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    points.forEach((point) => bounds.extend({ lat: point.lat, lng: point.lng }));
    map.fitBounds(bounds, 64);
  }, [map, points]);
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
  const mapId = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID;

  const [points, setPoints] = useState<MapPoint[]>([]);
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
          return response.json() as Promise<{ points: MapPoint[] }>;
        })
        .then((json) => setPoints(json.points ?? []))
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
        >
          {points.map((point) =>
            mapId ? (
              <AdvancedMarker
                key={point.id}
                position={{ lat: point.lat, lng: point.lng }}
                onClick={() => setSelected(point.id)}
              >
                <Pin
                  background={scoreColor(point.score)}
                  borderColor="#ffffff"
                  glyphColor="#ffffff"
                />
              </AdvancedMarker>
            ) : (
              <Marker
                key={point.id}
                position={{ lat: point.lat, lng: point.lng }}
                onClick={() => setSelected(point.id)}
                title={point.title ?? undefined}
              />
            ),
          )}

          {selectedPoint && (
            <InfoWindow
              position={{ lat: selectedPoint.lat, lng: selectedPoint.lng }}
              onCloseClick={() => setSelected(null)}
              pixelOffset={[0, mapId ? -36 : -40]}
            >
              <div className="flex max-w-[220px] flex-col gap-1 p-1">
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
                    className="mt-1 self-start text-[11px] font-medium text-blue-600 hover:underline"
                  >
                    {t("detail.tabs.about")} →
                  </button>
                )}
              </div>
            </InfoWindow>
          )}

          <FitBounds points={points} />
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

      <div className="pointer-events-none absolute right-2 bottom-2 rounded bg-background/80 px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {t("map.attribution")}
      </div>
    </div>
  );
}
