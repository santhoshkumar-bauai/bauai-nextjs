"use client";

import { CalendarClock, MapPin } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useFormatter, useTranslations } from "next-intl";

import type { SerializedTender } from "@/lib/tenders/serialize";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  CLOSING_SOON: "bg-amber-50 text-amber-700 ring-amber-600/20",
  UPCOMING: "bg-sky-50 text-sky-700 ring-sky-600/20",
};

function formatValue(
  amount: string | null,
  currency: string | null,
  locale: string,
): string | null {
  if (!amount) return null;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "EUR",
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `${numeric.toLocaleString(locale)} ${currency ?? ""}`.trim();
  }
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-14 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary/70"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </span>
    </div>
  );
}

export function TenderCard({
  tender,
  onOpen,
}: {
  tender: SerializedTender;
  onOpen: (id: string) => void;
}) {
  const t = useTranslations("Tenders");
  const format = useFormatter();

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(tender.id);
    }
  };

  const statusStyle =
    STATUS_STYLES[tender.status] ?? "bg-muted text-muted-foreground ring-border";
  const matchPct = Math.round(tender.score * 100);
  const value = formatValue(
    tender.estimatedValue.amount,
    tender.estimatedValue.currency,
    "de-DE",
  );
  const cpvShown = tender.cpvCodes.slice(0, 4);
  const cpvExtra = tender.cpvCodes.length - cpvShown.length;

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={() => onOpen(tender.id)}
      onKeyDown={handleKeyDown}
      className="flex cursor-pointer flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs transition-shadow hover:border-primary/30 hover:shadow-sm focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${statusStyle}`}
          >
            {t(`status.${tender.status}` as "status.OPEN")}
          </span>
        </div>
        <span
          className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary"
          title={`CPV ${Math.round(tender.scoreBreakdown.cpv * 100)}% · ${t("card.breakdown.geo")} ${Math.round(tender.scoreBreakdown.geo * 100)}% · ${t("card.breakdown.time")} ${Math.round(tender.scoreBreakdown.time * 100)}%`}
        >
          {t("card.match", { percent: matchPct })}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <span className="line-clamp-2 text-sm font-semibold text-foreground">
          {tender.title ?? "—"}
        </span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <MapPin className="size-3.5 shrink-0" />
          <span className="truncate">
            {[tender.buyer.name, tender.buyer.city].filter(Boolean).join(" · ") || "—"}
          </span>
        </span>
      </div>

      {tender.description && (
        <p className="line-clamp-2 text-xs text-muted-foreground">
          {tender.description}
        </p>
      )}

      {cpvShown.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {cpvShown.map((code) => (
            <span
              key={code}
              className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {code}
            </span>
          ))}
          {cpvExtra > 0 && (
            <span className="rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {t("card.cpvMore", { count: cpvExtra })}
            </span>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CalendarClock className="size-3.5 shrink-0" />
          {tender.submissionDeadline
            ? `${t("card.deadline")}: ${format.dateTime(new Date(tender.submissionDeadline), { dateStyle: "medium" })}`
            : t("card.noDeadline")}
        </span>
        <span className="text-right">
          {t("card.value")}: {value ?? t("card.notProvided")}
        </span>
      </div>

      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <ScoreBar label={t("card.breakdown.cpv")} value={tender.scoreBreakdown.cpv} />
        <ScoreBar label={t("card.breakdown.geo")} value={tender.scoreBreakdown.geo} />
        <ScoreBar label={t("card.breakdown.time")} value={tender.scoreBreakdown.time} />
      </div>
    </article>
  );
}
