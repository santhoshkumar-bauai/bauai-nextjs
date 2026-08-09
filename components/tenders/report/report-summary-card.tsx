"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  CalendarClock,
  ShieldAlert,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { TenderReportSummary } from "@/lib/ai/report/service";
import { cn } from "@/lib/utils";

/**
 * One report as a card: the verdict, the opening of the executive summary, and
 * the two counts a bid manager scans for (hard requirement gaps, high risks).
 * Used wherever reports are listed rather than read — today the chat.
 */

const DECISION_VARIANT = {
  bid: "success",
  conditional: "warning",
  no_bid: "danger",
} as const;

export function ReportSummaryCard({
  summary,
  className,
}: {
  summary: TenderReportSummary;
  className?: string;
}) {
  const t = useTranslations("Tenders.report");
  const format = useFormatter();

  return (
    <Link
      href={`/tenders/${summary.tenderId}/report`}
      className={cn(
        "group flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={DECISION_VARIANT[summary.decision]}>
          {t(`recommendation.decision.${summary.decision}` as "recommendation.decision.bid")}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {Math.round(summary.confidence * 100)}% {t("recommendation.confidence")}
        </span>
        {summary.maybeStale && (
          <Badge variant="neutral">
            <AlertTriangle />
            {t("staleShort")}
          </Badge>
        )}
        <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
      </div>

      <p className="line-clamp-1 text-sm font-medium text-foreground">
        {summary.tenderTitle ?? "—"}
      </p>
      {summary.headline && (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {summary.headline}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
        {summary.gapCount > 0 && (
          <span className="flex items-center gap-1 text-rose-600">
            <ShieldAlert className="size-3" />
            {t("summary.gaps", { count: summary.gapCount })}
          </span>
        )}
        {summary.highRiskCount > 0 && (
          <span className="flex items-center gap-1 text-amber-700">
            <AlertTriangle className="size-3" />
            {t("summary.highRisks", { count: summary.highRiskCount })}
          </span>
        )}
        {summary.submissionDeadline && (
          <span className="flex items-center gap-1">
            <CalendarClock className="size-3" />
            {format.dateTime(new Date(summary.submissionDeadline), {
              dateStyle: "medium",
            })}
          </span>
        )}
        <span className="ml-auto">
          {format.dateTime(new Date(summary.generatedAt), { dateStyle: "short" })}
        </span>
      </div>
    </Link>
  );
}
