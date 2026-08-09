"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, LayoutList, Loader2, Map as MapIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";

import { RegionSwitcher } from "@/components/tenders/region-switcher";
import { SavedFilters } from "@/components/tenders/saved-filters";
import { TenderCard } from "@/components/tenders/tender-card";
import { TenderDetailDialog } from "@/components/tenders/tender-detail-dialog";
import { TenderToolbar } from "@/components/tenders/tender-toolbar";
import {
  parseTenderFilters,
  tenderFiltersToParams,
  type TenderFilters,
} from "@/lib/tenders/filters";
import type { NutsResolution } from "@/lib/tenders/nuts";
import type { SerializedTender } from "@/lib/tenders/serialize";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

const TenderMap = dynamic(
  () => import("@/components/tenders/tender-map").then((m) => m.TenderMap),
  {
    ssr: false,
    loading: () => <MapPlaceholder />,
  },
);

interface ApiResponse {
  items: SerializedTender[];
  page: number;
  pageSize: number;
  total: number;
  profile: {
    cpv: string[];
    nuts: NutsResolution;
    region: string | null;
    hasCoordinates: boolean;
  };
}

function MapPlaceholder() {
  const t = useTranslations("Tenders");
  return (
    <div className="grid h-[560px] place-items-center rounded-xl border border-border bg-muted/30 text-sm text-muted-foreground">
      <span className="flex items-center gap-2">
        <Loader2 className="size-4 animate-spin" />
        {t("map.loading")}
      </span>
    </div>
  );
}

export function RelevantTenders() {
  const t = useTranslations("Tenders");
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Initialise from the URL so filtered views are shareable / bookmarkable.
  const [view, setView] = useState<"list" | "map">(() =>
    searchParams.get("view") === "map" ? "map" : "list",
  );
  const [filters, setFilters] = useState<TenderFilters>(() =>
    parseTenderFilters(new URLSearchParams(searchParams.toString())),
  );
  const [debouncedQ, setDebouncedQ] = useState(
    () => parseTenderFilters(new URLSearchParams(searchParams.toString())).q ?? "",
  );
  const [page, setPage] = useState(() => {
    const parsed = Number.parseInt(searchParams.get("page") ?? "0", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  });
  const [refreshKey, setRefreshKey] = useState(0);

  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectedTenderId, setSelectedTenderId] = useState<string | null>(null);
  // Tenders decided on this page. The server already excludes them on the next
  // fetch; this keeps them from flashing back before that happens.
  const [decided, setDecided] = useState<Set<string>>(new Set());

  // Debounce only the free-text query; chip changes apply immediately.
  useEffect(() => {
    const id = setTimeout(() => {
      setDebouncedQ(filters.q ?? "");
      setPage(0);
    }, 300);
    return () => clearTimeout(id);
  }, [filters.q]);

  const effectiveFilters = useMemo<TenderFilters>(
    () => ({ ...filters, q: debouncedQ || undefined }),
    [filters, debouncedQ],
  );

  const queryString = useMemo(
    () =>
      tenderFiltersToParams(effectiveFilters, {
        page: String(page),
        pageSize: String(PAGE_SIZE),
      }).toString(),
    [effectiveFilters, page],
  );

  // Mirror state into the browser URL (no navigation/refetch) so the current
  // view can be shared or bookmarked. `history.replaceState` avoids the RSC
  // round-trip that router.replace would trigger on this dynamic route.
  useEffect(() => {
    const params = tenderFiltersToParams(effectiveFilters);
    if (view === "map") params.set("view", "map");
    if (page > 0) params.set("page", String(page));
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      qs ? `${pathname}?${qs}` : pathname,
    );
  }, [effectiveFilters, view, page, pathname]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(false);
      fetch(`/api/tenders/relevant?${queryString}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<ApiResponse>;
        })
        .then((json) => setData(json))
        .catch((cause) => {
          if (!controller.signal.aborted) setError(true);
          void cause;
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [queryString, refreshKey]);

  const updateFilters = (next: TenderFilters) => {
    setFilters(next);
    setPage(0);
  };
  const applyPreset = (preset: TenderFilters) => {
    setFilters(preset);
    setDebouncedQ(preset.q ?? "");
    setPage(0);
  };

  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const nuts = data?.profile.nuts;
  const nutsRegion = nuts?.nuts3 || nuts?.nuts2 || nuts?.nuts1 || nuts?.country;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
          {data && (
            <p className="text-xs text-muted-foreground">
              {t("why.label")}: {t("why.cpv")} ({data.profile.cpv.length})
              {nutsRegion ? ` · ${t("why.region")}: ${nutsRegion}` : ""}
            </p>
          )}
        </div>

        <div className="inline-flex shrink-0 rounded-lg border border-border bg-background p-0.5">
          <button
            type="button"
            onClick={() => setView("list")}
            aria-pressed={view === "list"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              view === "list"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <LayoutList className="size-4" />
            {t("views.list")}
          </button>
          <button
            type="button"
            onClick={() => setView("map")}
            aria-pressed={view === "map"}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              view === "map"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <MapIcon className="size-4" />
            {t("views.map")}
          </button>
        </div>
      </header>

      <TenderToolbar
        filters={filters}
        onChange={updateFilters}
        savedSlot={
          <>
            <RegionSwitcher
              region={data?.profile.region ?? null}
              // Region feeds the geo score and the distance hints, so a change
              // has to re-run the query rather than just relabel the chip.
              onSaved={() => setRefreshKey((key) => key + 1)}
            />
            <SavedFilters currentFilters={filters} onApply={applyPreset} />
          </>
        }
      />

      {view === "map" ? (
        <TenderMap
          filters={effectiveFilters}
          onOpenDetail={setSelectedTenderId}
        />
      ) : loading && !data ? (
        <ListSkeleton />
      ) : error ? (
        <StateCard
          title={t("states.errorTitle")}
          description={t("states.errorDescription")}
          action={{ label: t("states.retry"), onClick: () => setRefreshKey((k) => k + 1) }}
        />
      ) : total === 0 ? (
        <StateCard
          title={t("states.emptyTitle")}
          description={t("states.emptyDescription")}
        />
      ) : (
        <>
          <div
            className={cn(
              "grid gap-3 sm:grid-cols-2",
              loading && "pointer-events-none opacity-60",
            )}
          >
            {data?.items
              .filter((tender) => !decided.has(tender.id))
              .map((tender) => (
                <TenderCard
                  key={tender.id}
                  tender={tender}
                  onOpen={setSelectedTenderId}
                  onDecided={(tenderId, status) => {
                    if (status === "deadzone") {
                      setDecided((prev) => new Set(prev).add(tenderId));
                      return;
                    }
                    // Moved to the board: refetch so it comes back labelled
                    // "In workspace" instead of offering the action bar again.
                    setRefreshKey((key) => key + 1);
                  }}
                />
              ))}
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-xs text-muted-foreground">
              {t("pagination.showing", { from, to, total })}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronLeft className="size-3.5" />
                {t("pagination.previous")}
              </button>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1 || loading}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-40"
              >
                {t("pagination.next")}
                <ChevronRight className="size-3.5" />
              </button>
            </div>
          </div>
        </>
      )}

      <TenderDetailDialog
        tenderId={selectedTenderId}
        onClose={() => setSelectedTenderId(null)}
        // A decision taken inside the popup has to reach the feed too: rejected
        // tenders drop out, workspace ones come back labelled "In workspace".
        onDecided={() => setRefreshKey((key) => key + 1)}
      />
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <div
          key={index}
          className="h-48 animate-pulse rounded-xl border border-border bg-muted/40"
        />
      ))}
    </div>
  );
}

function StateCard({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-16 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
