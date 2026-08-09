"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import type { ReportRunState } from "@/lib/ai/report/runs";
import type { SerializedTenderReport } from "@/lib/ai/report/service";

/**
 * The report page's data lifecycle, built around a run record the SERVER owns.
 *
 * Generation takes minutes, so the client is never the thing keeping it alive:
 * POST claims a run and returns immediately, the work continues server-side,
 * and this hook watches the run. That is what makes the page resumable — a
 * reload, a closed tab, or a second tab all rejoin the same generation instead
 * of losing it or starting a duplicate.
 */

/** Polling cadence while a run is in flight. */
const POLL_INTERVAL_MS = 2_000;

interface ReportResponse {
  report: SerializedTenderReport | null;
  run: ReportRunState | null;
}

export function useTenderReport(tenderId: string) {
  const t = useTranslations("Tenders.report");
  // Ask for exactly the language being rendered rather than relying on the
  // locale cookie, which lags a just-switched locale by one request.
  const locale = useLocale();

  const [data, setData] = useState<SerializedTenderReport | null>(null);
  const [run, setRun] = useState<ReportRunState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Set the moment Generate is pressed, before the first run record arrives,
  // so the button never appears to do nothing.
  const [starting, setStarting] = useState(false);

  // Changing language changes the endpoint, which re-identifies `read` and so
  // re-runs the load effect — exactly the behaviour we want.
  const endpoint = `/api/tenders/${tenderId}/report?locale=${locale}`;

  const errorMessage = useCallback(
    (code: string | null) =>
      code === "rate_limited" ? t("rateLimited") : t("error"),
    [t],
  );

  const read = useCallback(
    async (signal?: AbortSignal): Promise<ReportResponse | null> => {
      const response = await fetch(endpoint, { signal });
      if (!response.ok) return null;
      return (await response.json()) as ReportResponse;
    },
    [endpoint],
  );

  const apply = useCallback(
    (json: ReportResponse) => {
      setData(json.report);
      setRun(json.run);
      if (json.run?.status === "running") setStarting(false);
      if (json.run?.status === "failed") {
        setError(errorMessage(json.run.error));
        setStarting(false);
      }
      if (json.run?.status === "done") setStarting(false);
    },
    [errorMessage],
  );

  // Initial load — and, when a generation is already in flight (started here
  // before a reload, or by a colleague), it is picked up rather than hidden.
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      read(controller.signal)
        .then((json) => {
          if (json) apply(json);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [read, apply]);

  // Poll only while something is actually running.
  const active = run?.status === "running" || starting;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const id = setInterval(() => {
      void read(controller.signal)
        .then((json) => {
          if (json) apply(json);
        })
        .catch(() => undefined);
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
      controller.abort();
    };
  }, [active, read, apply]);

  const generate = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const json = (await response.json().catch(() => ({}))) as {
        run?: ReportRunState | null;
        error?: string;
      };
      if (!response.ok) {
        setError(json.error || t("error"));
        setStarting(false);
        return;
      }
      if (json.run) setRun(json.run);
    } catch {
      setError(t("error"));
      setStarting(false);
    }
  }, [endpoint, t]);

  return {
    data,
    loading,
    error,
    generate,
    /** True whenever a generation is in flight, whoever started it. */
    generating: active,
    /** Current step, or null before the first run record lands. */
    stage: run?.status === "running" ? run.stage : null,
    /** Set when the in-flight run was started by someone else / another tab. */
    run,
  };
}
