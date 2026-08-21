"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { MatchRunState } from "@/components/tenders/ai-match-progress";
import type { MatchCoverage } from "@/components/tenders/match-coverage-nudge";
import type { NutsResolution } from "@/lib/tenders/nuts";
import type { SerializedTender } from "@/lib/tenders/serialize";

/**
 * The tender feed, paged on the server and accumulated on the client.
 *
 * Both feed endpoints stay offset-paged — nothing about the API changes here.
 * What changes is that a page is appended to the previous ones instead of
 * replacing them, so the UI can scroll continuously while the network still
 * moves twenty tenders at a time.
 */

export const PAGE_SIZE = 20;

/** Feed states the AI endpoint can report; the classic feed has none. */
export type MatchFeedState =
  | "ready"
  | "stale"
  | "computing"
  | "never"
  | "empty"
  | "unavailable";

export interface TenderFeedResponse {
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

interface Options {
  /** Feed endpoint for the active mode. */
  endpoint: string;
  /** Filters and locale, already serialized — the hook owns `page`/`pageSize`. */
  query: string;
  /** Bump to throw the accumulated pages away and start again at page 0. */
  refreshKey: number;
  /** Called with page 0 of every fresh run (mode fallback, coverage, …). */
  onFirstPage?: (response: TenderFeedResponse) => void;
}

export interface TenderFeed {
  /** Page 0 of the current run — the source for totals, state and profile. */
  meta: TenderFeedResponse | null;
  /** Every page loaded so far, flattened and de-duplicated. */
  items: SerializedTender[];
  /** A fresh run is in flight (filters, mode, refresh). */
  loading: boolean;
  /** A follow-up page is in flight. */
  loadingMore: boolean;
  /** The fresh run failed; nothing newer than `meta` is on screen. */
  error: boolean;
  /** The follow-up page failed — recoverable by calling `loadMore` again. */
  loadMoreFailed: boolean;
  hasMore: boolean;
  loadMore: () => void;
}

export function useTenderFeed({
  endpoint,
  query,
  refreshKey,
  onFirstPage,
}: Options): TenderFeed {
  const [pages, setPages] = useState<TenderFeedResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  // Every reset opens a new generation; a page that resolves after the query
  // changed belongs to the old one and is dropped rather than appended.
  const generationRef = useRef(0);

  const onFirstPageRef = useRef(onFirstPage);
  useEffect(() => {
    onFirstPageRef.current = onFirstPage;
  }, [onFirstPage]);

  const load = useCallback(
    async (page: number, generation: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const first = page === 0;
      if (first) {
        setLoading(true);
        setError(false);
        setLoadMoreFailed(false);
      } else {
        setLoadingMore(true);
        setLoadMoreFailed(false);
      }

      try {
        const response = await fetch(
          `${endpoint}?${query}&page=${page}&pageSize=${PAGE_SIZE}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = (await response.json()) as TenderFeedResponse;
        if (generation !== generationRef.current) return;
        // Page 0 replaces rather than clears on the way out: the previous
        // results stay on screen (dimmed) until the new ones land.
        setPages((prev) => (first ? [json] : [...prev, json]));
        if (first) onFirstPageRef.current?.(json);
      } catch {
        if (controller.signal.aborted) return;
        if (generation !== generationRef.current) return;
        if (first) setError(true);
        else setLoadMoreFailed(true);
      } finally {
        if (generation === generationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [endpoint, query],
  );

  // A new query, mode or refresh starts over at page 0. The kick-off is
  // deferred by a tick so the pending flags land in their own render rather
  // than cascading out of this effect.
  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    const timer = setTimeout(() => void load(0, generation), 0);
    return () => {
      clearTimeout(timer);
      abortRef.current?.abort();
    };
  }, [load, refreshKey]);

  const meta = pages[0] ?? null;
  const ranked = meta?.rankedTotal ?? 0;
  const lastPage = pages[pages.length - 1];
  const hasMore =
    !loading &&
    lastPage !== undefined &&
    lastPage.items.length > 0 &&
    pages.length * PAGE_SIZE < ranked;

  const items = useMemo(() => {
    // The corpus can shift between page requests, so the same tender can come
    // back on two pages. Dropping the repeat keeps React keys unique.
    const seen = new Set<string>();
    return pages.flatMap((page) =>
      page.items.filter((tender) => {
        if (seen.has(tender.id)) return false;
        seen.add(tender.id);
        return true;
      }),
    );
  }, [pages]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !hasMore) return;
    void load(pages.length, generationRef.current);
  }, [hasMore, load, loading, loadingMore, pages.length]);

  return {
    meta,
    items,
    loading,
    loadingMore,
    error,
    loadMoreFailed,
    hasMore,
    loadMore,
  };
}
