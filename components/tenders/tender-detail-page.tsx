"use client";

import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";

import { ClaraAssistant } from "./detail/clara-assistant";
import { TenderDecisionActions } from "./detail/decision-actions";
import { TenderDetailTabs } from "./detail/detail-tabs";
import { DeadlineChip } from "./detail/header-summary";
import { buyerLine, useTenderDetail } from "./detail/use-tender-detail";

const STATUS_VARIANT = {
  OPEN: "success",
  CLOSING_SOON: "warning",
  UPCOMING: "info",
} as const;

/**
 * Full-screen counterpart of `TenderDetailDialog`, reached from the popup's
 * expand button or by linking straight to /tenders/{id}. Same data, same tabs,
 * same decision actions — just the whole viewport instead of a popup.
 */
export function TenderDetailPage({
  tenderId,
  initialTab,
}: {
  tenderId: string;
  /** Which tab opens first — e.g. "documents" when linked from the kanban board. */
  initialTab?: "about" | "documents" | "schedule" | "ai";
}) {
  const t = useTranslations("Tenders");
  const tReport = useTranslations("Tenders.report");
  const { detail, files, decision, setDecision, loading, error, fit, docFetch } =
    useTenderDetail(tenderId);

  const statusVariant =
    detail && detail.status in STATUS_VARIANT
      ? STATUS_VARIANT[detail.status as keyof typeof STATUS_VARIANT]
      : "neutral";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6 sm:py-8">
      <Link
        href="/tenders"
        className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t("detail.back")}
      </Link>

      {loading ? (
        <div className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-6">
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : error || !detail ? (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-muted/20 px-6 py-16 text-center">
          <p className="text-sm font-medium text-foreground">
            {t("states.errorTitle")}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {t("states.errorDescription")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xs">
          <header className="flex flex-col gap-3 border-b border-border px-4 py-5 sm:px-6">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant}>
                {t(`status.${detail.status}` as "status.OPEN")}
              </Badge>
              <DeadlineChip deadlineIso={detail.submissionDeadline} />
            </div>
            <h1 className="text-xl font-semibold text-foreground sm:text-2xl">
              {detail.title ?? "—"}
            </h1>
            {buyerLine(detail) && (
              <p className="text-sm text-muted-foreground">{buyerLine(detail)}</p>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <TenderDecisionActions
                tenderId={tenderId}
                status={decision}
                onChange={setDecision}
              />
              <Link
                href={`/tenders/${tenderId}/report`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
              >
                <FileText className="size-3.5" />
                {tReport("openReport")}
              </Link>
            </div>
          </header>

          <TenderDetailTabs
            tenderId={tenderId}
            detail={detail}
            files={files}
            docFetch={docFetch}
            className="flex flex-col gap-0"
            listWrapperClassName="border-b border-border px-4 py-3 sm:px-6"
            panelClassName="px-4 py-5 sm:px-6"
            initialTab={initialTab}
          />
        </div>
      )}

      {detail && !loading && (
        <ClaraAssistant
          tenderId={tenderId}
          fit={fit}
          className="fixed right-6 bottom-6 z-30"
        />
      )}
    </div>
  );
}
