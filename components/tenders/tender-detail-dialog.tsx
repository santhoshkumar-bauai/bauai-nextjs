"use client";

import { Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SerializedTenderDetail } from "@/lib/tenders/detail";
import type { TenderRecommendation } from "@/lib/tenders/recommendation";
import { AboutTab } from "./detail/about-tab";
import { DocumentsTab } from "./detail/documents-tab";
import { DoraAssistant } from "./detail/dora-assistant";
import { ExtractionsSection } from "./detail/extractions-section";
import { DeadlineChip } from "./detail/header-summary";
import { ScheduleTab } from "./detail/schedule-tab";

export function TenderDetailDialog({
  tenderId,
  onClose,
}: {
  tenderId: string | null;
  onClose: () => void;
}) {
  const t = useTranslations("Tenders");

  const [detail, setDetail] = useState<SerializedTenderDetail | null>(null);
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
      setError(false);
      setLoading(true);
      setRec(null);
      setRecStale(false);
      setRecGeneratedAt(null);
      setRecError(null);
      fetch(`/api/tenders/${tenderId}`, { signal: controller.signal })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{ tender: SerializedTenderDetail }>;
        })
        .then((json) => setDetail(json.tender))
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

  const buyerLocation = detail?.buyer?.address
    ? [detail.buyer.address.city, detail.buyer.address.postalCode]
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <Dialog open={tenderId !== null} onOpenChange={(open) => !open && onClose()}>
      {/* No `relative` here: tailwind-merge would replace the popup's `fixed`
          positioning and break centering. The popup's transform already makes
          it the containing block for the floating assistant. */}
      <DialogContent className="h-[85svh] max-h-[720px] max-w-3xl">
        <DialogHeader>
          <DialogTitle className="pr-2">
            {loading ? t("detail.loading") : (detail?.title ?? "—")}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span>
              {[detail?.buyer?.name, buyerLocation].filter(Boolean).join(" — ") || " "}
            </span>
            {detail && <DeadlineChip deadlineIso={detail.submissionDeadline} />}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-1/2" />
          </div>
        ) : error || !detail ? (
          <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
            {t("states.errorTitle")}
          </div>
        ) : (
          <Tabs defaultValue="about" className="flex min-h-0 flex-1 flex-col gap-0">
            <div className="border-b border-border px-6 py-3">
              <TabsList className="w-full">
                <TabsTrigger value="about">{t("detail.tabs.about")}</TabsTrigger>
                <TabsTrigger value="documents">
                  {t("detail.tabs.documents")}
                </TabsTrigger>
                <TabsTrigger value="schedule">
                  {t("detail.tabs.schedule")}
                </TabsTrigger>
                <TabsTrigger value="ai">
                  <Sparkles className="size-3.5" />
                  {t("detail.tabs.ai")}
                </TabsTrigger>
              </TabsList>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <TabsContent value="about" className="pt-2">
                <AboutTab detail={detail} />
              </TabsContent>
              <TabsContent value="documents" className="pt-2">
                <DocumentsTab detail={detail} />
              </TabsContent>
              <TabsContent value="schedule" className="pt-2">
                <ScheduleTab detail={detail} />
              </TabsContent>
              <TabsContent value="ai" className="pt-2 pb-16">
                <ExtractionsSection tenderId={tenderId} />
              </TabsContent>
            </div>
          </Tabs>
        )}
        {detail && !loading && (
          <DoraAssistant
            tenderId={tenderId}
            fit={{
              rec,
              stale: recStale,
              generatedAt: recGeneratedAt,
              loading: recLoading,
              error: recError,
              onGenerate: generateRecommendation,
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
