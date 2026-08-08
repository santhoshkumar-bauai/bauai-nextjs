"use client";

import { useFormatter, useTranslations } from "next-intl";

import { presentFieldValue } from "@/lib/ai/extraction/present";
import { Badge } from "@/components/ui/badge";

/** Locale-aware renderer for one extraction field value. */
export function ExtractionValue({
  fieldName,
  value,
}: {
  fieldName: string;
  value: unknown;
}) {
  const t = useTranslations("Tenders.ai");
  const format = useFormatter();
  const presented = presentFieldValue(fieldName, value);

  switch (presented.kind) {
    case "datetime":
      return (
        <span>
          {format.dateTime(new Date(presented.iso), {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
      );
    case "date":
      return (
        <span>
          {format.dateTime(new Date(presented.iso), { dateStyle: "medium" })}
        </span>
      );
    case "currency":
      return (
        <span>
          {format.number(presented.amount, {
            style: "currency",
            currency: "EUR",
            maximumFractionDigits: 0,
          })}
        </span>
      );
    case "percent":
      return <span>{format.number(presented.value)} %</span>;
    case "days":
      return <span>{t("days", { days: presented.value })}</span>;
    case "number":
      return <span>{format.number(presented.value)}</span>;
    case "boolean":
      return <span>{presented.value ? t("yes") : t("no")}</span>;
    case "text":
      return <span className="whitespace-pre-wrap">{presented.value}</span>;
    case "stringList":
      return (
        <span className="flex flex-wrap gap-1">
          {presented.items.map((item, index) => (
            <Badge key={index} variant="neutral" className="text-[10px]">
              {item}
            </Badge>
          ))}
        </span>
      );
    case "criteria":
      return (
        <span className="flex flex-col gap-0.5">
          {presented.items.map((item, index) => (
            <span key={index} className="flex items-baseline justify-between gap-3">
              <span>{item.name}</span>
              {item.weightPercent != null && (
                <span className="shrink-0 font-semibold">{item.weightPercent} %</span>
              )}
            </span>
          ))}
        </span>
      );
    case "proofs":
      return (
        <span className="flex flex-col gap-1">
          {presented.items.map((item, index) => (
            <span key={index} className="flex flex-wrap items-center gap-1.5">
              <span>{item.name}</span>
              <Badge variant="neutral">
                {t(`proofKind.${item.proofKind}` as "proofKind.certificate")}
              </Badge>
              {item.due && (
                <Badge variant="info">{t(`due.${item.due}` as "due.with_bid")}</Badge>
              )}
              {item.mandatory && <Badge variant="warning">{t("mandatory")}</Badge>}
            </span>
          ))}
        </span>
      );
    case "clauses":
      return (
        <span className="flex flex-col gap-1">
          {presented.items.map((item, index) => (
            <span key={index} className="text-foreground/90">
              {item.text}
              {item.legalRef && (
                <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">
                  {item.legalRef}
                </span>
              )}
            </span>
          ))}
        </span>
      );
    default:
      return <span className="text-muted-foreground">—</span>;
  }
}
