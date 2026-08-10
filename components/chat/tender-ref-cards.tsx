"use client";

import { ArrowUpRight, CalendarClock, FileText, MessageCircleMore } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { WireTenderRef } from "@/lib/ai/agent/wire";
import { PIPELINE_STATUSES } from "@/lib/tenders/pipeline-status";
import { cn } from "@/lib/utils";

/**
 * The tenders an answer is about, as cards that open the tender.
 *
 * Clara names tenders in prose, which leaves the reader with a title and no
 * way to act on it. The server collects every tender its tools surfaced
 * (lib/ai/agent/tender-refs.ts) and this renders them underneath the answer:
 * one click into the tender's page, plus the report when one exists and a
 * tender-scoped conversation when the user wants to dig in.
 */

const DECISION_VARIANT = {
  bid: "success",
  conditional: "warning",
  no_bid: "danger",
} as const;

/** Beyond this the cards stop being a shortcut and become a second answer. */
const COLLAPSED_COUNT = 3;

function DeadlineBadge({ tender }: { tender: WireTenderRef }) {
  const t = useTranslations("Tenders.card");
  if (tender.daysUntilDeadline === null) return null;
  return (
    <Badge
      variant={
        tender.daysUntilDeadline < 0
          ? "neutral"
          : tender.daysUntilDeadline <= 7
            ? "danger"
            : "info"
      }
    >
      <CalendarClock />
      {t("daysLeft", { days: Math.max(tender.daysUntilDeadline, 0) })}
    </Badge>
  );
}

function TenderRefCard({
  tender,
  compact,
}: {
  tender: WireTenderRef;
  compact: boolean;
}) {
  const t = useTranslations("Chat.tenders");
  const tCard = useTranslations("Tenders.card");
  const tReport = useTranslations("Tenders.report");
  const tBoard = useTranslations("Workspace.kanban");
  const format = useFormatter();

  const pipelineStatus = PIPELINE_STATUSES.find(
    (status) => status === tender.workspaceStatus,
  );

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card transition-colors hover:border-primary/40">
      <Link
        href={`/tenders/${tender.tenderId}`}
        className="group flex flex-col gap-1.5 px-3 py-2.5"
      >
        <div className="flex flex-wrap items-center gap-1">
          {tender.decision && (
            <Badge variant={DECISION_VARIANT[tender.decision]}>
              {tReport(
                `recommendation.decision.${tender.decision}` as "recommendation.decision.bid",
              )}
            </Badge>
          )}
          <DeadlineBadge tender={tender} />
          {pipelineStatus && (
            <Badge variant="primary">{tBoard(`columns.${pipelineStatus}`)}</Badge>
          )}
          {tender.workspaceStatus === "deadzone" && (
            <Badge variant="neutral">{tBoard("deadZone")}</Badge>
          )}
          {tender.matchScore !== null && (
            <span className="text-[10px] text-muted-foreground">
              {tCard("match", { percent: Math.round(tender.matchScore * 100) })}
            </span>
          )}
          <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
        </div>

        <p
          className={cn(
            "line-clamp-2 font-medium text-foreground",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {tender.title ?? t("untitled")}
        </p>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
          {tender.buyer && <span className="line-clamp-1">{tender.buyer}</span>}
          <span className="ml-auto whitespace-nowrap">
            {tender.submissionDeadline
              ? `${tCard("deadline")}: ${format.dateTime(
                  new Date(tender.submissionDeadline),
                  { dateStyle: "medium" },
                )}`
              : tCard("noDeadline")}
          </span>
        </div>
      </Link>

      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[10px]">
        {tender.hasReport && (
          <Link
            href={`/tenders/${tender.tenderId}/report`}
            className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-primary"
          >
            <FileText className="size-3" />
            {t("report")}
          </Link>
        )}
        <Link
          href={`/chat?tender=${tender.tenderId}`}
          className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-primary"
        >
          <MessageCircleMore className="size-3" />
          {t("ask")}
        </Link>
      </div>
    </div>
  );
}

export function TenderRefCards({
  refs,
  density = "compact",
  className,
}: {
  refs: WireTenderRef[] | undefined;
  density?: "compact" | "comfortable";
  className?: string;
}) {
  const t = useTranslations("Chat.tenders");
  const [expanded, setExpanded] = useState(false);

  if (!refs || refs.length === 0) return null;
  const shown = expanded ? refs : refs.slice(0, COLLAPSED_COUNT);
  const hidden = refs.length - shown.length;

  return (
    <div className={cn("flex w-full max-w-[90%] flex-col gap-1.5", className)}>
      <p className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        {t("heading")}
      </p>
      <div
        className={cn(
          "grid gap-1.5",
          density === "comfortable" && refs.length > 1 && "sm:grid-cols-2",
        )}
      >
        {shown.map((tender) => (
          <TenderRefCard
            key={tender.tenderId}
            tender={tender}
            compact={density === "compact"}
          />
        ))}
      </div>
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="self-start text-[10px] font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          {expanded ? t("showLess") : t("showMore", { count: hidden })}
        </button>
      )}
    </div>
  );
}
