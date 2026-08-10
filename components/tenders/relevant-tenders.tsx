"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  LayoutList,
  Loader2,
  Map as MapIcon,
  RefreshCw,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  AiMatchProgress,
  useMatchRunPolling,
  type MatchRunState,
} from "@/components/tenders/ai-match-progress";
import {
  MatchCoverageNudge,
  type MatchCoverage,
} from "@/components/tenders/match-coverage-nudge";
import { RegionSwitcher } from "@/components/tenders/region-switcher";
import { SavedFilters } from "@/components/tenders/saved-filters";
import { TenderCard } from "@/components/tenders/tender-card";
import { TenderDetailDialog } from "@/components/tenders/tender-detail-dialog";
import {
  TenderModeTabs,
  type TenderMode,
} from "@/components/tenders/tender-mode-tabs";
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

/** Feed states the AI endpoint can report; the classic feed has none. */
type MatchFeedState =
  | "ready"
  | "stale"
  | "computing"
  | "never"
  | "empty"
  | "unavailable";

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
  /** Every tender matching the filters. */
  total: number;
  /** The pageable slice of that — the top `RANK_CAP` by relevance. */
  rankedTotal: number;
  profile: {
    cpv: string[];
    nuts: NutsResolution;
    region: string | null;
    hasCoordinates: boolean;
  };
  /** AI mode only — absent from the classic endpoint's response. */
  state?: MatchFeedState;
  run?: MatchRunState | null;
  coverage?: MatchCoverage | null;
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
  const locale = useLocale();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Initialise from the URL so filtered views are shareable / bookmarkable.
  // AI is the default landing feed, so only the classic mode is serialized.
  const [mode, setMode] = useState<TenderMode>(() =>
    searchParams.get("mode") === "classic" ? "classic" : "ai",
  );
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
        // The AI reason is generated in both languages and picked server-side.
        locale,
      }).toString(),
    [effectiveFilters, page, locale],
  );

  // Mirror state into the browser URL (no navigation/refetch) so the current
  // view can be shared or bookmarked. `history.replaceState` avoids the RSC
  // round-trip that router.replace would trigger on this dynamic route.
  useEffect(() => {
    const params = tenderFiltersToParams(effectiveFilters);
    if (mode === "classic") params.set("mode", "classic");
    if (view === "map") params.set("view", "map");
    if (page > 0) params.set("page", String(page));
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      qs ? `${pathname}?${qs}` : pathname,
    );
  }, [effectiveFilters, mode, view, page, pathname]);

  useEffect(() => {
    const controller = new AbortController();
    const endpoint =
      mode === "ai" ? "/api/tenders/ai-matched" : "/api/tenders/relevant";
    const timer = setTimeout(() => {
      setLoading(true);
      setError(false);
      fetch(`${endpoint}?${queryString}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<ApiResponse>;
        })
        .then((json) => {
          setData(json);
          // The deployment cannot do AI matching at all (kill switch, or no
          // Atlas Search) — fall back rather than leaving the user on a tab
          // that will never produce anything.
          if (json.state === "unavailable") setMode("classic");
        })
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
  }, [queryString, refreshKey, mode]);

  // ---- AI mode -----------------------------------------------------------
  const matchState = mode === "ai" ? (data?.state ?? null) : null;
  const isComputing = matchState === "computing";

  // While a refresh is live, poll the tiny status endpoint rather than the
  // whole feed; on completion, refetch once so the new results land.
  const polledRun = useMatchRunPolling(
    isComputing,
    useCallback(() => setRefreshKey((key) => key + 1), []),
  );
  const run = polledRun ?? data?.run ?? null;

  const [refreshing, setRefreshing] = useState(false);
  const startRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetch("/api/tenders/ai-matched/refresh", { method: "POST" });
      setRefreshKey((key) => key + 1);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const changeMode = (next: TenderMode) => {
    setMode(next);
    setPage(0);
  };

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
  // Only the ranked pool is pageable, so the pager bounds come from that —
  // while the label still reports how many tenders matched in total.
  const ranked = data?.rankedTotal ?? 0;
  const totalPages = Math.max(1, Math.ceil(ranked / PAGE_SIZE));
  const from = ranked === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(ranked, (page + 1) * PAGE_SIZE);
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

        <div className="flex shrink-0 flex-wrap items-center gap-2">
        <TenderModeTabs mode={mode} onChange={changeMode} />

        {/* The map re-queries the deterministic feed, so it stays a
            classic-mode view until the AI geo endpoint exists. */}
        {mode === "classic" && (
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
        )}
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

      {mode === "ai" && data?.coverage && (
        <MatchCoverageNudge coverage={data.coverage} />
      )}

      {/* A live or failed run is reported above the results, not instead of
          them: a refresh must never blank out the previous matches. */}
      {mode === "ai" && run && (isComputing || run.status === "failed") && (
        <AiMatchProgress run={run} onRetry={startRefresh} />
      )}

      {mode === "ai" && matchState === "stale" && (
        <StaleBanner
          onRefresh={startRefresh}
          busy={refreshing}
          label={t("aiMatched.states.staleTitle")}
          description={t("aiMatched.states.staleDescription")}
          action={
            refreshing ? t("aiMatched.run.refreshing") : t("aiMatched.run.refresh")
          }
        />
      )}

      {mode === "ai" && matchState === "never" && !isComputing ? (
        <StateCard
          title={t("aiMatched.states.neverTitle")}
          description={t("aiMatched.states.neverDescription")}
          action={{
            label: refreshing
              ? t("aiMatched.run.refreshing")
              : t("aiMatched.states.neverAction"),
            onClick: startRefresh,
          }}
        />
      ) : mode === "classic" && view === "map" ? (
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
        isComputing ? null : (
          <StateCard
            title={
              mode === "ai" ? t("aiMatched.states.emptyTitle") : t("states.emptyTitle")
            }
            description={
              mode === "ai"
                ? t("aiMatched.states.emptyDescription")
                : t("states.emptyDescription")
            }
          />
        )
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
              {total > ranked
                ? t("pagination.showingRanked", { from, to, ranked, total })
                : t("pagination.showing", { from, to, total })}
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

/**
 * Results are stale but still shown. A banner rather than a blocking state:
 * out-of-date matches are far more useful than none.
 */
function StaleBanner({
  onRefresh,
  busy,
  label,
  description,
  action,
}: {
  onRefresh: () => void;
  busy: boolean;
  label: string;
  description: string;
  action: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/30 bg-amber-50/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:bg-amber-950/20">
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        disabled={busy}
        className="inline-flex w-fit shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
        {action}
      </button>
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
