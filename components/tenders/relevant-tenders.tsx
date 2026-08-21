"use client";

import dynamic from "next/dynamic";
import { usePathname, useSearchParams } from "next/navigation";
import { LayoutList, Loader2, Map as MapIcon, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import {
  AiMatchProgress,
  useMatchRunPolling,
} from "@/components/tenders/ai-match-progress";
import { MatchCoverageNudge } from "@/components/tenders/match-coverage-nudge";
import { RegionSwitcher } from "@/components/tenders/region-switcher";
import { SavedFilters } from "@/components/tenders/saved-filters";
import { TenderCard } from "@/components/tenders/tender-card";
import { TenderDetailDialog } from "@/components/tenders/tender-detail-dialog";
import {
  TenderDetailPanel,
  type TenderPanelTab,
} from "@/components/tenders/detail/tender-detail-panel";
import {
  TenderModeTabs,
  type TenderMode,
} from "@/components/tenders/tender-mode-tabs";
import { TenderToolbar } from "@/components/tenders/tender-toolbar";
import {
  useTenderFeed,
  type TenderFeedResponse,
} from "@/components/tenders/use-tender-feed";
import { useMediaQuery } from "@/components/otto/use-media-query";
import {
  parseTenderFilters,
  tenderFiltersToParams,
  type TenderFilters,
} from "@/lib/tenders/filters";
import type { DecisionStatus } from "@/lib/tenders/pipeline-status";
import { cn } from "@/lib/utils";

/** Below this the detail pane has no room, so the popup takes over. */
const SPLIT_QUERY = "(min-width: 1024px)";

/** How far ahead of the sentinel the next page starts loading. */
const PREFETCH_MARGIN = "600px";

const TenderMap = dynamic(
  () => import("@/components/tenders/tender-map").then((m) => m.TenderMap),
  {
    ssr: false,
    loading: () => <MapPlaceholder />,
  },
);

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
  const isSplit = useMediaQuery(SPLIT_QUERY);

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
    () =>
      parseTenderFilters(new URLSearchParams(searchParams.toString())).q ?? "",
  );
  const [refreshKey, setRefreshKey] = useState(0);

  const [selectedTenderId, setSelectedTenderId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<TenderPanelTab>("about");
  // Decisions taken while the feed is open. The server applies them on the next
  // fresh run; until then they are overlaid here, so that neither a rejected
  // tender lingers nor one moved to the board keeps offering the action bar —
  // and neither costs the reader the scroll position they built up.
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [inWorkspace, setInWorkspace] = useState<Set<string>>(new Set());

  // Debounce only the free-text query; chip changes apply immediately.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(filters.q ?? ""), 300);
    return () => clearTimeout(id);
  }, [filters.q]);

  const effectiveFilters = useMemo<TenderFilters>(
    () => ({ ...filters, q: debouncedQ || undefined }),
    [filters, debouncedQ],
  );

  // Paging is left to the feed hook — this is only the filter half of the query.
  const queryString = useMemo(
    () =>
      tenderFiltersToParams(effectiveFilters, {
        // The AI reason is generated in both languages and picked server-side.
        locale,
      }).toString(),
    [effectiveFilters, locale],
  );

  // Mirror state into the browser URL (no navigation/refetch) so the current
  // view can be shared or bookmarked. `history.replaceState` avoids the RSC
  // round-trip that router.replace would trigger on this dynamic route.
  useEffect(() => {
    const params = tenderFiltersToParams(effectiveFilters);
    if (mode === "classic") params.set("mode", "classic");
    if (view === "map") params.set("view", "map");
    const qs = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      qs ? `${pathname}?${qs}` : pathname,
    );
  }, [effectiveFilters, mode, view, pathname]);

  const onFirstPage = useCallback((response: TenderFeedResponse) => {
    // The deployment cannot do AI matching at all (kill switch, or no Atlas
    // Search) — fall back rather than leaving the user on a tab that will
    // never produce anything.
    if (response.state === "unavailable") setMode("classic");
  }, []);

  // Server-side paging, client-side continuity: pages are appended, never
  // swapped, so the reader scrolls one list instead of stepping through them.
  const feed = useTenderFeed({
    endpoint: mode === "ai" ? "/api/tenders/ai-matched" : "/api/tenders/relevant",
    query: queryString,
    refreshKey,
    onFirstPage,
  });
  const { loading, loadingMore, error, hasMore, loadMore } = feed;
  const data = feed.meta;

  // The scroll container is the observer root, so the sentinel fires off the
  // feed's own scrolling rather than the window's.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { root, rootMargin: `${PREFETCH_MARGIN} 0px` },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  // A new query is a new list: start it at the top rather than wherever the
  // previous one happened to be scrolled to. `refreshKey` counts here too —
  // a finished AI run collapses the accumulated pages back to twenty, and
  // without this the reader is left clamped to the bottom of the short list.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [queryString, mode, refreshKey]);

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

  const changeMode = (next: TenderMode) => setMode(next);

  const updateFilters = (next: TenderFilters) => setFilters(next);
  const applyPreset = (preset: TenderFilters) => {
    setFilters(preset);
    setDebouncedQ(preset.q ?? "");
  };

  const openTender = useCallback(
    (tenderId: string, tab: TenderPanelTab = "about") => {
      setSelectedTenderId(tenderId);
      setDetailTab(tab);
    },
    [],
  );

  /**
   * Record a decision without refetching. Dropping a card or relabelling it in
   * place is what the next fresh run would produce anyway, and it leaves the
   * accumulated pages — and the scroll position — untouched.
   */
  const applyDecision = useCallback(
    (tenderId: string, status: DecisionStatus | null) => {
      const hidden = status === "deadzone" || status === "deleted";
      setRejected((prev) => {
        const next = new Set(prev);
        if (hidden) next.add(tenderId);
        else next.delete(tenderId);
        return next;
      });
      setInWorkspace((prev) => {
        const next = new Set(prev);
        if (status && !hidden) next.add(tenderId);
        else next.delete(tenderId);
        return next;
      });
    },
    [],
  );

  const items = useMemo(
    () =>
      feed.items
        .filter((tender) => !rejected.has(tender.id))
        .map((tender) =>
          inWorkspace.has(tender.id) && tender.pipelineStatus === null
            ? { ...tender, pipelineStatus: "interested" }
            : tender,
        ),
    [feed.items, rejected, inWorkspace],
  );

  // What the detail pane shows, derived rather than stored: an explicit pick
  // wins for as long as it is still on the page, and the first result stands in
  // the rest of the time — so the pane is never blank next to a full list, and
  // never left pointing at a tender that was decided on, filtered out or paged
  // away. The popup on narrow screens uses `selectedTenderId` itself: there,
  // nothing is open until something is tapped.
  const activeTenderId = useMemo(() => {
    if (!isSplit) return null;
    if (selectedTenderId && items.some((t) => t.id === selectedTenderId)) {
      return selectedTenderId;
    }
    return items[0]?.id ?? null;
  }, [isSplit, items, selectedTenderId]);

  const total = data?.total ?? 0;
  // Only the ranked pool is reachable, so the progress label counts against
  // that — while still reporting how many tenders matched in total.
  const ranked = data?.rankedTotal ?? 0;
  const shown = items.length;
  const isMap = mode === "classic" && view === "map";

  const feedBody =
    mode === "ai" && matchState === "never" && !isComputing ? (
      <StateCard
        tourId="build-ai-matches"
        title={t("aiMatched.states.neverTitle")}
        description={t("aiMatched.states.neverDescription")}
        action={{
          label: refreshing
            ? t("aiMatched.run.refreshing")
            : t("aiMatched.states.neverAction"),
          onClick: startRefresh,
        }}
      />
    ) : loading && !data ? (
      <ListSkeleton />
    ) : error ? (
      <StateCard
        title={t("states.errorTitle")}
        description={t("states.errorDescription")}
        action={{
          label: t("states.retry"),
          onClick: () => setRefreshKey((k) => k + 1),
        }}
      />
    ) : total === 0 ? (
      isComputing ? null : (
        <StateCard
          title={
            mode === "ai"
              ? t("aiMatched.states.emptyTitle")
              : t("states.emptyTitle")
          }
          description={
            mode === "ai"
              ? t("aiMatched.states.emptyDescription")
              : t("states.emptyDescription")
          }
        />
      )
    ) : (
      <div
        className={cn(
          "flex flex-col gap-3",
          // A fresh run is in flight; the previous results stay readable but
          // inert. Appended pages never dim — the list below them is live.
          loading && "pointer-events-none opacity-60",
        )}
      >
        {items.map((tender) => (
          <TenderCard
            key={tender.id}
            tender={tender}
            selected={tender.id === activeTenderId}
            onOpen={openTender}
            onDecided={applyDecision}
          />
        ))}

        {/* Tripwire for the next page, kept a screenful ahead of the fold so
            the tenders are already there by the time the reader gets down to
            them. `hasMore` gates it, so the last page ends cleanly. */}
        {hasMore && <div ref={sentinelRef} aria-hidden className="h-px" />}

        {loadingMore && <LoadingMoreRow label={t("pagination.loadingMore")} />}

        {/* The observer covers the normal case; this covers the rest — a failed
            page, and any browser or setting where it never fires. */}
        {hasMore && !loadingMore && (
          <button
            type="button"
            onClick={loadMore}
            className="mx-auto rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            {feed.loadMoreFailed
              ? t("states.retry")
              : t("pagination.loadMore")}
          </button>
        )}
      </div>
    );

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background max-[560px]:h-[calc(100svh-64px)]">
      <h1 className="sr-only">{t("title")}</h1>

      {/* Toolbar — one row of controls above the split, like a mail client. */}
      <div className="shrink-0 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur sm:px-5">
        <TenderToolbar
          filters={filters}
          onChange={updateFilters}
          leadingSlot={
            <RegionSwitcher
              region={data?.profile.region ?? null}
              // Region feeds the geo score and the distance hints, so a change
              // has to re-run the query rather than just relabel the chip.
              onSaved={() => setRefreshKey((key) => key + 1)}
            />
          }
          viewSlot={
            // The map re-queries the deterministic feed, so it stays a
            // classic-mode view until the AI geo endpoint exists.
            mode === "classic" ? (
              <button
                type="button"
                onClick={() => setView(view === "map" ? "list" : "map")}
                aria-pressed={view === "map"}
                className={cn(
                  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors",
                  view === "map"
                    ? "border-primary/40 bg-primary/5 text-primary"
                    : "border-border bg-background text-foreground hover:bg-muted",
                )}
              >
                {view === "map" ? (
                  <LayoutList className="size-3.5" />
                ) : (
                  <MapIcon className="size-3.5" />
                )}
                {view === "map" ? t("views.list") : t("views.map")}
              </button>
            ) : null
          }
          savedSlot={
            <SavedFilters currentFilters={filters} onApply={applyPreset} />
          }
          trailingSlot={<TenderModeTabs mode={mode} onChange={changeMode} />}
        />
      </div>

      {isMap ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          <TenderMap filters={effectiveFilters} onOpenDetail={openTender} />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Feed */}
          <div className="flex min-h-0 flex-col">
            <div
              ref={scrollRef}
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4 sm:px-5"
            >
              {mode === "ai" && data?.coverage && (
                <MatchCoverageNudge coverage={data.coverage} />
              )}

              {/* A live or failed run is reported above the results, not instead
                  of them: a refresh must never blank out the previous matches. */}
              {mode === "ai" &&
                run &&
                (isComputing || run.status === "failed") && (
                  <AiMatchProgress run={run} onRetry={startRefresh} />
                )}

              {mode === "ai" && matchState === "stale" && (
                <StaleBanner
                  onRefresh={startRefresh}
                  busy={refreshing}
                  label={t("aiMatched.states.staleTitle")}
                  description={t("aiMatched.states.staleDescription")}
                  action={
                    refreshing
                      ? t("aiMatched.run.refreshing")
                      : t("aiMatched.run.refresh")
                  }
                />
              )}

              {feedBody}
            </div>

            {/* The pager's replacement — how far into the list the reader has
                got. The list itself says when the next page is coming. */}
            {total > 0 && (
              <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 sm:px-5">
                <span className="text-[11px] text-muted-foreground">
                  {total > ranked
                    ? t("pagination.shownRanked", { shown, ranked, total })
                    : t("pagination.shown", { shown, total })}
                </span>
              </div>
            )}
          </div>

          {/* Detail — desktop only; narrow screens keep the popup. */}
          {isSplit && (
            <aside className="hidden min-h-0 border-l border-border bg-card lg:flex lg:flex-col">
              <TenderDetailPanel
                tenderId={activeTenderId}
                tab={detailTab}
                onTabChange={setDetailTab}
                className="min-h-0 flex-1"
              />
            </aside>
          )}
        </div>
      )}

      {!isSplit && (
        <TenderDetailDialog
          tenderId={selectedTenderId}
          onClose={() => setSelectedTenderId(null)}
          initialTab={detailTab === "client" ? "about" : detailTab}
          // A decision taken inside the popup has to reach the feed too: rejected
          // tenders drop out, workspace ones come back labelled "In workspace".
          onDecided={applyDecision}
        />
      )}
    </div>
  );
}

/**
 * Placeholder for the page being appended. Card-shaped rather than a bare
 * spinner, so the list keeps its rhythm and the scrollbar stops jumping as
 * each page lands.
 */
function LoadingMoreRow({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="grid h-24 place-items-center rounded-2xl border border-dashed border-border bg-muted/20 text-xs text-muted-foreground"
    >
      <span className="flex items-center gap-2">
        <Loader2 className="size-3.5 animate-spin" />
        {label}
      </span>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: 5 }).map((_, index) => (
        <div
          key={index}
          className="h-52 animate-pulse rounded-2xl border border-border bg-muted/40"
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
  tourId,
}: {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  /** Onboarding spotlight target; see lib/onboarding/milestones.ts. */
  tourId?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-6 py-16 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      {action && (
        <button
          type="button"
          data-tour={tourId}
          onClick={action.onClick}
          className="mt-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
