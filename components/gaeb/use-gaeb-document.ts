"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { computeTotals } from "@/lib/gaeb/totals";

import type { GaebApiPriceEntry, GaebViewResponse } from "./api-types";

/**
 * Loads the GAEB view and owns the working prices (Layer C mirror). Edits
 * apply optimistically, live totals come from the shared isomorphic math, and
 * a debounced batch PATCH persists — the server's totals response is
 * authoritative if they ever disagree.
 */

export interface WorkingPrice {
  unitPrice: number | null;
  decision: GaebApiPriceEntry["decision"];
  suggestionRunId: string | null;
}

export interface PriceEdit {
  itemKey: string;
  unitPrice?: number | null;
  decision?: GaebApiPriceEntry["decision"];
  suggestionRunId?: string | null;
}

const FLUSH_DELAY_MS = 600;

export function useGaebDocument(documentId: string) {
  const [view, setView] = useState<GaebViewResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [prices, setPrices] = useState<Map<string, WorkingPrice>>(new Map());
  const [sourceConflict, setSourceConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadTick, setLoadTick] = useState(0);

  const dirtyRef = useRef<Map<string, PriceEdit>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shaRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/workspace-documents/${documentId}/gaeb`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (!response.ok) {
          setLoadState("error");
          return;
        }
        const body = (await response.json()) as GaebViewResponse;
        if (cancelled) return;
        setView(body);
        shaRef.current = body.source.sha256;
        const next = new Map<string, WorkingPrice>();
        if (body.priceSheet && !body.priceSheetStale) {
          for (const [itemKey, entry] of Object.entries(body.priceSheet.prices)) {
            next.set(itemKey, {
              unitPrice: entry.unitPrice,
              decision: entry.decision,
              suggestionRunId: entry.suggestionRunId,
            });
          }
        }
        setPrices(next);
        setSourceConflict(false);
        setLoadState("ready");
      } catch {
        if (!cancelled) setLoadState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, loadTick]);

  const load = useCallback(async () => {
    setLoadTick((tick) => tick + 1);
  }, []);

  const flush = useCallback(async () => {
    if (dirtyRef.current.size === 0 || !shaRef.current) return;
    const batch = Array.from(dirtyRef.current.values());
    dirtyRef.current = new Map();
    setSaving(true);
    try {
      const response = await fetch(`/api/workspace-documents/${documentId}/gaeb/prices`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSha256: shaRef.current, updates: batch }),
      });
      if (response.status === 409) {
        setSourceConflict(true);
        return;
      }
    } catch {
      // Re-queue so the next edit retries the failed batch.
      for (const edit of batch) {
        if (!dirtyRef.current.has(edit.itemKey)) dirtyRef.current.set(edit.itemKey, edit);
      }
    } finally {
      setSaving(false);
    }
  }, [documentId]);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }, [flush]);

  // Flush pending edits when the surface unmounts.
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      void flush();
    };
  }, [flush]);

  const applyEdits = useCallback(
    (edits: PriceEdit[]) => {
      setPrices((previous) => {
        const next = new Map(previous);
        for (const edit of edits) {
          const current = next.get(edit.itemKey) ?? {
            unitPrice: null,
            decision: null,
            suggestionRunId: null,
          };
          next.set(edit.itemKey, {
            unitPrice: edit.unitPrice === undefined ? current.unitPrice : edit.unitPrice,
            decision: edit.decision === undefined ? current.decision : edit.decision,
            suggestionRunId:
              edit.suggestionRunId === undefined
                ? current.suggestionRunId
                : edit.suggestionRunId,
          });
        }
        return next;
      });
      for (const edit of edits) {
        const pending = dirtyRef.current.get(edit.itemKey);
        dirtyRef.current.set(edit.itemKey, { ...pending, ...edit });
      }
      scheduleFlush();
    },
    [scheduleFlush],
  );

  const resetForCurrentVersion = useCallback(async () => {
    if (!shaRef.current) return;
    await fetch(`/api/workspace-documents/${documentId}/gaeb/prices`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceSha256: shaRef.current, reset: true, updates: [] }),
    });
    await load();
  }, [documentId, load]);

  const parsed = view?.gaeb.document ?? null;

  /** Live totals over the optimistic working prices. Rejected = unpriced. */
  const totals = useMemo(() => {
    if (!parsed) return null;
    const map = new Map<string, number | null>();
    for (const [itemKey, price] of prices) {
      if (price.decision === "rejected") continue;
      map.set(itemKey, price.unitPrice);
    }
    return computeTotals({
      items: parsed.items,
      prices: map,
      vatRate: parsed.meta.vatRate,
      categories: parsed.categories,
    });
  }, [parsed, prices]);

  const reload = useCallback(async () => {
    setLoadState("loading");
    await load();
  }, [load]);

  return {
    view,
    parsed,
    loadState,
    reload,
    prices,
    applyEdits,
    totals,
    saving,
    sourceConflict: sourceConflict || Boolean(view?.priceSheetStale),
    resetForCurrentVersion,
  };
}
