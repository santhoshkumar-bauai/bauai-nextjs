"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { GaebApiFillItem, GaebApiFillRun, GaebFillResponse } from "./api-types";

/**
 * Fill-run lifecycle for the BOQ editor. Progress is read from the persisted
 * run document (poll while active), so a reload resumes exactly where the run
 * is — the brief panel's pattern, not request-scoped state.
 */

const POLL_MS = 2_000;
const ACTIVE = new Set(["queued", "analyzing", "generating"]);

export function useGaebFill(documentId: string, sourceStorageRevision: number | null) {
  const [run, setRun] = useState<GaebApiFillRun | null>(null);
  const [items, setItems] = useState<Map<string, GaebApiFillItem>>(new Map());
  const [busy, setBusy] = useState<"" | "start" | "retry" | "generate" | "cancel">("");
  const [actionError, setActionError] = useState<string | null>(null);

  const sinceRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stoppedRef = useRef(false);

  const mergeItems = useCallback((incoming: GaebApiFillItem[]) => {
    if (incoming.length === 0) return;
    setItems((previous) => {
      const next = new Map(previous);
      for (const item of incoming) {
        next.set(item.itemKey, item);
        if (!sinceRef.current || item.updatedAt > sinceRef.current) {
          sinceRef.current = item.updatedAt;
        }
      }
      return next;
    });
  }, []);

  const refresh = useCallback(async () => {
    const query = sinceRef.current ? `?since=${encodeURIComponent(sinceRef.current)}` : "";
    const response = await fetch(
      `/api/workspace-documents/${documentId}/gaeb/fill${query}`,
      { cache: "no-store" },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as GaebFillResponse;
    if (body.run) {
      setRun((previous) => {
        // A brand-new run means the item set restarted.
        if (previous && body.run && previous.id !== body.run.id) {
          sinceRef.current = null;
          setItems(new Map());
        }
        return body.run;
      });
    } else {
      setRun(null);
    }
    mergeItems(body.items);
    return body.run;
  }, [documentId, mergeItems]);

  // Poll while a run is active; stop as soon as it settles.
  useEffect(() => {
    stoppedRef.current = false;
    const tick = async () => {
      const current = await refresh().catch(() => null);
      if (stoppedRef.current) return;
      if (current && ACTIVE.has(current.status)) {
        timerRef.current = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    return () => {
      stoppedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [refresh]);

  const post = useCallback(
    async (
      action: "analyze" | "retry_failed" | "generate",
      busyKey: "start" | "retry" | "generate",
    ) => {
      if (sourceStorageRevision === null) return;
      setBusy(busyKey);
      setActionError(null);
      try {
        const response = await fetch(`/api/workspace-documents/${documentId}/gaeb/fill`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action, sourceStorageRevision }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          run?: GaebApiFillRun;
          error?: string;
        };
        if (!response.ok) {
          setActionError(body.error ?? `request_failed_${response.status}`);
          return;
        }
        if (body.run) {
          sinceRef.current = null;
          setItems(new Map());
          setRun(body.run);
        }
        // Restart polling for the fresh run.
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => void refresh(), 400);
      } finally {
        setBusy("");
      }
    },
    [documentId, refresh, sourceStorageRevision],
  );

  const cancel = useCallback(async () => {
    setBusy("cancel");
    try {
      await fetch(`/api/workspace-documents/${documentId}/gaeb/fill`, { method: "DELETE" });
      await refresh();
    } finally {
      setBusy("");
    }
  }, [documentId, refresh]);

  return {
    run,
    suggestions: items,
    busy,
    actionError,
    refresh,
    start: () => post("analyze", "start"),
    retryFailed: () => post("retry_failed", "retry"),
    generate: () => post("generate", "generate"),
    cancel,
  };
}
