"use client";

import { AlertTriangle, FileText, Loader2, ShieldAlert, Sparkles } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { ReportProgress } from "@/components/tenders/report/report-progress";
import { useTenderReport } from "@/components/tenders/report/use-tender-report";

/**
 * The tender's full report, pinned above the conversation in a tender chat.
 *
 * Clara answers questions turn by turn; the report is the standing written
 * answer to "should we bid, and what does it take". Showing its verdict here
 * means a user who opens the chat sees the conclusion without having to ask
 * for it again — and can start one, or watch one already running, in place.
 */

const DECISION_VARIANT = {
  bid: "success",
  conditional: "warning",
  no_bid: "danger",
} as const;

export function TenderReportPanel({ tenderId }: { tenderId: string }) {
  const t = useTranslations("Tenders.report");
  const { data, loading, error, generate, generating, stage } =
    useTenderReport(tenderId);

  if (loading) {
    return <div className="mb-4 h-20 animate-pulse rounded-xl bg-muted/60" />;
  }

  // A generation in flight — started here, on the report page, or by a
  // colleague. The run is server-owned, so all of them show the same progress.
  if (generating) {
    return (
      <div className="mb-4">
        <ReportProgress stage={stage} />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="mb-4 flex flex-col items-start gap-2 rounded-xl border border-dashed border-border bg-muted/20 px-4 py-3">
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <FileText className="size-3.5 text-primary" />
          {t("openReport")}
        </span>
        <p className="text-[11px] text-muted-foreground">
          {t("emptyDescription")}
        </p>
        <button
          type="button"
          onClick={generate}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[11px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <Sparkles className="size-3.5" />
          {t("generate")}
        </button>
        {error && <p className="text-[11px] text-rose-600">{error}</p>}
      </div>
    );
  }

  const report = data.report;
  const gaps = report.requirements.filter(
    (requirement) => requirement.companyStatus === "gap",
  ).length;
  const highRisks = report.risks.filter((risk) => risk.severity === "high").length;

  return (
    <Link
      href={`/tenders/${tenderId}/report`}
      className="group mb-4 flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-primary/40"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
          <FileText className="size-3.5 text-primary" />
          {t("openReport")}
        </span>
        <Badge variant={DECISION_VARIANT[report.recommendation.decision]}>
          {t(
            `recommendation.decision.${report.recommendation.decision}` as "recommendation.decision.bid",
          )}
        </Badge>
        <span className="text-[10px] text-muted-foreground">
          {Math.round(report.recommendation.confidence * 100)}%{" "}
          {t("recommendation.confidence")}
        </span>
        {data.stale && (
          <Badge variant="neutral">
            <AlertTriangle />
            {t("staleShort")}
          </Badge>
        )}
      </div>

      <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
        {report.executiveSummary.split(/\n{2,}/)[0]}
      </p>

      {(gaps > 0 || highRisks > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px]">
          {gaps > 0 && (
            <span className="flex items-center gap-1 text-rose-600">
              <ShieldAlert className="size-3" />
              {t("summary.gaps", { count: gaps })}
            </span>
          )}
          {highRisks > 0 && (
            <span className="flex items-center gap-1 text-amber-700">
              <AlertTriangle className="size-3" />
              {t("summary.highRisks", { count: highRisks })}
            </span>
          )}
        </div>
      )}
      {error && (
        <span className="flex items-center gap-1 text-[11px] text-rose-600">
          <Loader2 className="size-3" />
          {error}
        </span>
      )}
    </Link>
  );
}
