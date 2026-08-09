"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

import type { TenderReportSummary } from "@/lib/ai/report/service";

/** Every report this company has, as cards. Locale-aware like the report page. */
export function useReportSummaries() {
  const locale = useLocale();
  const [reports, setReports] = useState<TenderReportSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    // Deferred so setState runs outside the effect body (repo lint pattern).
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/tenders/reports?locale=${locale}`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then((json: { reports: TenderReportSummary[] } | null) => {
          if (json) setReports(json.reports);
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
  }, [locale]);

  return { reports, loading };
}
