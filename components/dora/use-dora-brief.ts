"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WireBriefStatus } from "@/lib/ai/dora/wire";

const POLL_MS = 1_500;

/**
 * Document Brief lifecycle for the Dora panel: load, poll while a run is in
 * flight (resumable — a reload lands back on the same run doc), auto-trigger
 * the first generation when the panel opens on a brief-less document.
 */
export function useDoraBrief(documentId: string, aiAvailable: boolean) {
  const endpoint = `/api/workspace-documents/${documentId}/dora/brief`;
  const [status, setStatus] = useState<WireBriefStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const autoTriggered = useRef(false);

  /** Pure fetch — no state. Kept separate so the mount effect can decide for
   * itself whether a late response is still wanted. */
  const fetchStatus = useCallback(async (): Promise<WireBriefStatus | null> => {
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      if (!response.ok) return null;
      return (await response.json()) as WireBriefStatus;
    } catch {
      return null;
    }
  }, [endpoint]);

  const load = useCallback(async (): Promise<WireBriefStatus | null> => {
    const json = await fetchStatus();
    if (json) setStatus(json);
    return json;
  }, [fetchStatus]);

  const generate = useCallback(
    async (refresh: boolean) => {
      setError(null);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh }),
        });
        if (!response.ok) {
          setError(response.status === 409 ? "not_ready" : "failed");
          return;
        }
        await load();
      } catch {
        setError("failed");
      }
    },
    [endpoint, load],
  );

  // Mount load. The await inside the IIFE is what keeps the state update out of
  // the effect body itself, and `ignore` stops a slow response for a previous
  // documentId from landing on top of a newer one.
  useEffect(() => {
    let ignore = false;
    void (async () => {
      const json = await fetchStatus();
      if (!ignore && json) setStatus(json);
    })();
    return () => {
      ignore = true;
    };
  }, [fetchStatus]);

  const running = status?.run?.status === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  // First open of a never-analyzed document: start the brief unprompted.
  useEffect(() => {
    if (!status || status.brief || status.run || !aiAvailable) return;
    if (autoTriggered.current) return;
    autoTriggered.current = true;
    void generate(false);
  }, [status, aiAvailable, generate]);

  return { status, error, running, generate };
}
