"use client";

import {
  ExternalLink,
  FileSearch,
  FileText,
  Globe,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

import { FitSection } from "./ai-tab";
import { ClientCard } from "./client-card";
import { DocumentsTab } from "./documents-tab";
import { ExtractionsSection } from "./extractions-section";
import { Field, SectionLabel } from "./field";
import { formatValue } from "./format";
import { DeadlineChip } from "./header-summary";
import { ScheduleTab } from "./schedule-tab";
import { buyerLine, useTenderDetail } from "./use-tender-detail";

export type TenderPanelTab =
  "about" | "documents" | "schedule" | "client" | "ai";

const STATUS_VARIANT = {
  OPEN: "success",
  CLOSING_SOON: "warning",
  UPCOMING: "info",
} as const;

/** Characters of description shown before the "Read more" toggle appears. */
const DESCRIPTION_PREVIEW = 420;

/**
 * The detail half of the split tenders view: one tender, in place, next to the
 * feed it was picked from. Same data and tabs as the popup (`TenderDetailDialog`,
 * still used on narrow screens) — the Client block is promoted to its own tab
 * and the fit recommendation moved up into About, where it is the first thing
 * worth reading.
 */
export function TenderDetailPanel({
  tenderId,
  tab,
  onTabChange,
  className,
}: {
  tenderId: string | null;
  tab: TenderPanelTab;
  onTabChange: (tab: TenderPanelTab) => void;
  className?: string;
}) {
  const t = useTranslations("Tenders");
  const tReport = useTranslations("Tenders.report");
  const locale = useLocale();
  const { detail, files, loading, error, fit, docFetch } =
    useTenderDetail(tenderId);

  if (!tenderId) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 px-8 text-center",
          className,
        )}
      >
        <FileSearch className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t("detail.selectTitle")}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t("detail.selectDescription")}
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={cn("flex flex-col gap-3 px-5 py-5", className)}>
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 px-8 text-center",
          className,
        )}
      >
        <p className="text-sm font-medium text-foreground">
          {t("states.errorTitle")}
        </p>
        <p className="max-w-xs text-xs text-muted-foreground">
          {t("states.errorDescription")}
        </p>
      </div>
    );
  }

  const statusVariant =
    detail.status in STATUS_VARIANT
      ? STATUS_VARIANT[detail.status as keyof typeof STATUS_VARIANT]
      : "neutral";
  const value = formatValue(
    detail.estimatedValue?.amount ?? null,
    detail.estimatedValue?.currency ?? null,
    locale,
  );
  // The portal the notice came from — the only place a bid can actually be filed.
  const externalUrl =
    detail.sourceLinks.find((link) => link.url)?.url ??
    detail.buyer?.website ??
    null;

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => onTabChange(next as TenderPanelTab)}
      className={cn("flex min-h-0 flex-col gap-0", className)}
    >
      <div className="shrink-0 border-b border-border px-4 py-3">
        <TabsList className="w-full overflow-x-auto">
          <TabsTrigger value="about">{t("detail.tabs.about")}</TabsTrigger>
          <TabsTrigger value="documents">
            {t("detail.tabs.documents")}
          </TabsTrigger>
          <TabsTrigger value="schedule">
            {t("detail.tabs.schedule")}
          </TabsTrigger>
          <TabsTrigger value="client">{t("detail.tabs.client")}</TabsTrigger>
          <TabsTrigger value="ai">
            <Sparkles className="size-3.5" />
            {t("detail.tabs.ai")}
          </TabsTrigger>
        </TabsList>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <TabsContent value="about" className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <h2 className="text-base leading-snug font-semibold text-foreground">
              {detail.title ?? "—"}
            </h2>
            {buyerLine(detail) && (
              <p className="text-xs text-muted-foreground">
                {buyerLine(detail)}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant}>
                {t(`status.${detail.status}` as "status.OPEN")}
              </Badge>
              <DeadlineChip deadlineIso={detail.submissionDeadline} />
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border bg-muted/20 px-3 py-2.5 text-xs">
            <Field label={t("detail.value")}>
              {value ?? t("card.notProvided")}
            </Field>
            <Field label={t("detail.procedure")}>
              {detail.procedureType ?? "—"}
            </Field>
            <Field label={t("detail.contractNature")}>
              {detail.contractNature ?? "—"}
            </Field>
            {detail.cpvCodes.length > 0 && (
              <Field label={t("detail.cpv")}>
                <span className="font-mono text-[11px]">
                  {detail.cpvCodes.slice(0, 3).join(", ")}
                  {detail.cpvCodes.length > 3 &&
                    ` +${detail.cpvCodes.length - 3}`}
                </span>
              </Field>
            )}
          </dl>

          {detail.description && (
            <ExpandableText
              text={detail.description}
              more={t("detail.readMore")}
              less={t("detail.readLess")}
            />
          )}

          <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3">
            <SectionLabel>{t("detail.aiRecommendation")}</SectionLabel>
            <FitSection {...fit} />
          </section>
        </TabsContent>

        <TabsContent value="documents">
          <DocumentsTab detail={detail} files={files} docFetch={docFetch} />
        </TabsContent>

        <TabsContent value="schedule">
          <ScheduleTab detail={detail} />
        </TabsContent>

        <TabsContent value="client">
          {detail.buyer ? (
            <ClientCard buyer={detail.buyer} />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("detail.buyer")}: —
            </p>
          )}
        </TabsContent>

        <TabsContent value="ai" className="pb-10">
          <ExtractionsSection tenderId={tenderId} />
        </TabsContent>
      </div>

      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <Link
          href={`/tenders/${tenderId}/report`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 px-3 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:border-primary/50 hover:bg-primary/10"
        >
          <FileText className="size-3.5" />
          {tReport("openReport")}
        </Link>
        {externalUrl && (
          <a
            href={externalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[11px] font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary"
          >
            <Globe className="size-3.5" />
            {t("detail.participate")}
            <ExternalLink className="size-3" />
          </a>
        )}
      </footer>
    </Tabs>
  );
}

/** Long tender descriptions are collapsed until asked for. */
function ExpandableText({
  text,
  more,
  less,
}: {
  text: string;
  more: string;
  less: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const clamped = text.length > DESCRIPTION_PREVIEW;

  return (
    <div className="flex flex-col items-start gap-1">
      <p
        className={cn(
          "text-sm whitespace-pre-wrap text-foreground/90",
          clamped && !expanded && "line-clamp-6",
        )}
      >
        {text}
      </p>
      {clamped && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="text-xs font-medium text-primary hover:underline"
        >
          {expanded ? less : more}
        </button>
      )}
    </div>
  );
}
