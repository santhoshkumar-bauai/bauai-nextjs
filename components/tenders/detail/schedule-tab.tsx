"use client";

import { ChevronDown, MapPin } from "lucide-react";
import { useState } from "react";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { deadlineDaysLeft, deadlineUrgency } from "@/lib/tenders/deadline";
import type { SerializedLot, SerializedTenderDetail } from "@/lib/tenders/detail";
import { cn } from "@/lib/utils";
import { Field, SectionLabel } from "./field";
import { formatValue } from "./format";

function LotRow({ lot }: { lot: SerializedLot }) {
  const t = useTranslations("Tenders");
  const format = useFormatter();
  const locale = useLocale();
  const [open, setOpen] = useState(false);

  const hasDetails =
    Boolean(lot.description) ||
    lot.cpvCodes.length > 0 ||
    Boolean(lot.estimatedValue?.amount) ||
    lot.locations.length > 0;

  const deadlineLabel = lot.submissionDeadline
    ? format.dateTime(new Date(lot.submissionDeadline), { dateStyle: "medium" })
    : t("card.noDeadline");
  const urgency = lot.submissionDeadline
    ? deadlineUrgency(deadlineDaysLeft(lot.submissionDeadline))
    : null;

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => hasDetails && setOpen(!open)}
        className={cn(
          "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs",
          hasDetails && "cursor-pointer hover:bg-muted/40",
        )}
      >
        <span className="min-w-0 truncate font-medium text-foreground">
          {lot.title ?? lot.lotId}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span
            className={cn(
              "text-muted-foreground",
              urgency === "critical" && "font-medium text-rose-600",
              urgency === "soon" && "font-medium text-amber-700",
            )}
          >
            {deadlineLabel}
          </span>
          {hasDetails && (
            <ChevronDown
              className={cn(
                "size-3.5 text-muted-foreground transition-transform",
                open && "rotate-180",
              )}
            />
          )}
        </span>
      </button>

      {open && hasDetails && (
        <div className="flex flex-col gap-2.5 border-t border-border px-3 py-2.5">
          {lot.description && (
            <p className="text-xs whitespace-pre-wrap text-foreground/90">
              {lot.description}
            </p>
          )}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            {lot.estimatedValue?.amount && (
              <Field label={t("detail.lotValue")}>
                {formatValue(
                  lot.estimatedValue.amount,
                  lot.estimatedValue.currency,
                  locale,
                )}
              </Field>
            )}
            {lot.submissionDeadline && (
              <Field
                label={t(
                  `detail.deadlineKind.${lot.deadlineKind ?? "NONE"}` as "detail.deadlineKind.TENDER",
                )}
              >
                {deadlineLabel}
              </Field>
            )}
            {lot.contractNature && (
              <Field label={t("detail.contractNature")}>{lot.contractNature}</Field>
            )}
          </dl>
          {lot.cpvCodes.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {lot.cpvCodes.map((code) => (
                <span
                  key={code}
                  className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                >
                  {code}
                </span>
              ))}
            </div>
          )}
          {lot.locations.length > 0 && (
            <span className="inline-flex items-start gap-1 text-[11px] text-muted-foreground">
              <MapPin className="mt-0.5 size-3 shrink-0" />
              {lot.locations
                .map((location) =>
                  [location.city, location.postalCode, location.countryCode]
                    .filter(Boolean)
                    .join(" "),
                )
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function ScheduleTab({ detail }: { detail: SerializedTenderDetail }) {
  const t = useTranslations("Tenders");
  const format = useFormatter();

  const daysLeft = detail.submissionDeadline
    ? deadlineDaysLeft(detail.submissionDeadline)
    : null;
  const urgency = daysLeft !== null ? deadlineUrgency(daysLeft) : null;

  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <Field label={t("detail.publication")}>
          {detail.publicationDate
            ? format.dateTime(new Date(detail.publicationDate), {
                dateStyle: "medium",
              })
            : "—"}
        </Field>
        <Field label={t("card.deadline")}>
          <span className="flex items-center gap-2">
            {detail.submissionDeadline
              ? format.dateTime(new Date(detail.submissionDeadline), {
                  dateStyle: "medium",
                })
              : t("card.noDeadline")}
            {urgency && urgency !== "normal" && daysLeft !== null && (
              <Badge
                variant={
                  urgency === "closed"
                    ? "neutral"
                    : urgency === "critical"
                      ? "danger"
                      : "warning"
                }
              >
                {urgency === "closed"
                  ? t("detail.countdown.closed")
                  : daysLeft === 0
                    ? t("detail.countdown.closesToday")
                    : t("detail.countdown.daysLeft", { days: daysLeft })}
              </Badge>
            )}
          </span>
        </Field>
      </dl>

      {detail.lots.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <SectionLabel>
            {t("detail.lots")} ({detail.lots.length})
          </SectionLabel>
          <div className="flex flex-col gap-1.5">
            {detail.lots.map((lot) => (
              <LotRow key={lot.lotId} lot={lot} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
