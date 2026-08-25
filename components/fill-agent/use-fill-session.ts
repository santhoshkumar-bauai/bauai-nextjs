"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { SerializedFillSession } from "@/lib/ai/fill-agent/store";

/**
 * Server-held session state (score, budgets, open questions, download
 * readiness) for the panel beside the chat. The chat stream doesn't carry
 * it — tools mutate Mongo — so the workspace refreshes this on turn
 * boundaries and on a slow poll while a turn runs.
 */
export function useFillSession(sessionId: string) {
  const [session, setSession] = useState<SerializedFillSession | null>(null);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/poc/fill-chat/${sessionId}`);
      if (!response.ok) return;
      const json = (await response.json()) as { session: SerializedFillSession };
      if (!aliveRef.current) return;
      setSession(json.session);
    } catch {
      // transient — the next refresh will catch up
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    aliveRef.current = true;
    // Deferred like use-clara-chat's bootstrap: keeps setState out of the
    // synchronous effect body (react-hooks/set-state-in-effect).
    const timer = setTimeout(() => void refresh(), 0);
    return () => {
      clearTimeout(timer);
      aliveRef.current = false;
    };
  }, [refresh]);

  /**
   * Cache identity of the sandbox page renders — changes ONLY when they can
   * actually differ (analyze produced source renders / a fill round produced
   * new output renders). The 4s status poll must never remount or refetch
   * the preview images, or they flicker for the whole turn.
   */
  const renderVersion = session
    ? `${session.analyzed ? 1 : 0}-${session.fillIterations}`
    : "0-0";

  return { session, loading, refresh, renderVersion };
}
