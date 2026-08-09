"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import type { SerializedTenderDetail } from "@/lib/tenders/detail";
import type { SerializedTenderFile } from "@/lib/tenders/document-files";
import type { TenderRecommendation } from "@/lib/tenders/recommendation";
import type { DecisionStatus } from "@/lib/tenders/pipeline-status";
import type { FitSectionProps } from "./ai-tab";

/**
 * Everything the detail surfaces need for one tender: the notice itself, its
 * fetched files, this company's pipeline decision and the cached fit
 * recommendation. Shared by the popup (`TenderDetailDialog`) and the full-page
 * view (`TenderDetailPage`) so the two can never drift apart.
 *
 * Pass `null` as the id to stay idle — that's how the popup avoids fetching
 * while it is closed.
 */
export function useTenderDetail(tenderId: string | null) {
  const t = useTranslations("Tenders");

  const [detail, setDetail] = useState<SerializedTenderDetail | null>(null);
  const [files, setFiles] = useState<SerializedTenderFile[]>([]);
  const [decision, setDecision] = useState<DecisionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const [rec, setRec] = useState<TenderRecommendation | null>(null);
  const [recStale, setRecStale] = useState(false);
  const [recGeneratedAt, setRecGeneratedAt] = useState<string | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recError, setRecError] = useState<string | null>(null);

  useEffect(() => {
    if (!tenderId) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setDetail(null);
      setFiles([]);
      setDecision(null);
      setError(false);
      setLoading(true);
      setRec(null);
      setRecStale(false);
      setRecGeneratedAt(null);
      setRecError(null);
      fetch(`/api/tenders/${tenderId}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{
            tender: SerializedTenderDetail;
            files?: SerializedTenderFile[];
            decision?: DecisionStatus | null;
          }>;
        })
        .then((json) => {
          setDetail(json.tender);
          setFiles(json.files ?? []);
          setDecision(json.decision ?? null);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
      // Cached fit recommendation (tenant-scoped, persisted server-side).
      fetch(`/api/tenders/${tenderId}/recommendation`, {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : null))
        .then(
          (json: {
            recommendation: TenderRecommendation | null;
            stale: boolean;
            generatedAt: string | null;
          } | null) => {
            if (json?.recommendation) {
              setRec(json.recommendation);
              setRecStale(json.stale);
              setRecGeneratedAt(json.generatedAt);
            }
          },
        )
        .catch(() => undefined);
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tenderId]);

  const generateRecommendation = useCallback(async () => {
    if (!tenderId) return;
    setRecLoading(true);
    setRecError(null);
    try {
      const response = await fetch(`/api/tenders/${tenderId}/recommendation`, {
        method: "POST",
      });
      const json = (await response.json()) as {
        recommendation?: TenderRecommendation;
        error?: string;
      };
      if (!response.ok || !json.recommendation) {
        setRecError(json.error || t("recommendation.error"));
        return;
      }
      setRec(json.recommendation);
      setRecStale(false);
      setRecGeneratedAt(new Date().toISOString());
    } catch {
      setRecError(t("recommendation.error"));
    } finally {
      setRecLoading(false);
    }
  }, [tenderId, t]);

  const fit: FitSectionProps = {
    rec,
    stale: recStale,
    generatedAt: recGeneratedAt,
    loading: recLoading,
    error: recError,
    onGenerate: generateRecommendation,
  };

  return { detail, files, decision, setDecision, loading, error, fit };
}

/** Buyer name + city/postal code, the subtitle both detail surfaces show. */
export function buyerLine(detail: SerializedTenderDetail | null): string {
  if (!detail) return "";
  const location = detail.buyer?.address
    ? [detail.buyer.address.city, detail.buyer.address.postalCode]
        .filter(Boolean)
        .join(" · ")
    : "";
  return [detail.buyer?.name, location].filter(Boolean).join(" — ");
}
