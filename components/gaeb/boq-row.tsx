"use client";

import { Check, X } from "lucide-react";
import { memo } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { GaebApiFillItem, GaebApiItem } from "./api-types";
import { PriceInput } from "./price-input";
import { formatMoney, formatQty, formatUnitPrice } from "./price-format";
import type { WorkingPrice } from "./use-gaeb-document";

/** Grid template shared with the sticky header in boq-table.tsx. */
export const BOQ_GRID =
  "grid grid-cols-[64px_minmax(0,1fr)_128px_104px] md:grid-cols-[88px_minmax(0,1fr)_72px_56px_200px_116px_112px]";

function confidenceVariant(confidence: number): "success" | "warning" | "neutral" {
  if (confidence >= 0.8) return "success";
  if (confidence >= 0.6) return "warning";
  return "neutral";
}

export const BoqRow = memo(function BoqRow({
  item,
  depth,
  working,
  lineTotal,
  fillItem,
  fillActive,
  locale,
  currency,
  readOnly,
  selected,
  onCommitPrice,
  onAccept,
  onReject,
  onSelect,
}: {
  item: GaebApiItem;
  depth: number;
  working: WorkingPrice | undefined;
  lineTotal: number | null;
  fillItem: GaebApiFillItem | undefined;
  fillActive: boolean;
  locale: string;
  currency: string;
  readOnly: boolean;
  selected: boolean;
  onCommitPrice: (itemKey: string, value: number | null) => void;
  onAccept: (itemKey: string) => void;
  onReject: (itemKey: string) => void;
  onSelect: (itemKey: string) => void;
}) {
  const t = useTranslations("Gaeb");
  const suggestion = fillItem?.status === "priced" ? fillItem.suggestion : null;
  const decision = working?.decision ?? null;
  const suggestionOpen = Boolean(suggestion) && decision === null;

  return (
    <div
      className={cn(
        BOQ_GRID,
        "cursor-pointer items-center border-b border-border/70 bg-white text-[13px] [contain-intrinsic-size:auto_44px] [content-visibility:auto]",
        "hover:bg-muted/30",
        selected && "bg-primary/[0.04]",
        item.notInTotal && "text-muted-foreground",
      )}
      onClick={() => onSelect(item.key)}
      role="row"
      aria-selected={selected}
    >
      <div
        className="py-2 pr-1 text-[12px] tabular-nums text-muted-foreground"
        style={{ paddingLeft: `${12 + depth * 18}px` }}
      >
        {item.oz}
      </div>

      <div className="min-w-0 py-2 pr-2">
        <p className={cn("truncate font-medium", item.notInTotal && "font-normal")}>
          {item.shortText}
        </p>
        {(item.markers.length > 0 || item.notInTotal) && (
          <span className="mt-0.5 flex flex-wrap gap-1">
            {item.markers.map((marker) => (
              <Badge key={marker} variant="neutral" className="px-1.5 py-0 text-[10px]">
                {t(`markers.${marker}`)}
              </Badge>
            ))}
            {item.notInTotal && (
              <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                {t("markers.notInTotal")}
              </Badge>
            )}
          </span>
        )}
      </div>

      <div className="hidden py-2 pr-2 text-right tabular-nums md:block">
        {formatQty(item.qty, locale)}
      </div>
      <div className="hidden py-2 pr-2 text-muted-foreground md:block">{item.qtyUnit ?? ""}</div>

      <div className="py-2 pr-2" onClick={(event) => event.stopPropagation()}>
        {suggestion ? (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold tabular-nums text-primary">
                {formatMoney(suggestion.unitPrice, locale, currency)}
              </p>
              <p className="hidden truncate text-[10px] tabular-nums text-muted-foreground md:block">
                {formatUnitPrice(suggestion.rangeLow, locale)}–{formatUnitPrice(suggestion.rangeHigh, locale)}
              </p>
            </div>
            <Badge
              variant={confidenceVariant(suggestion.confidence)}
              className="hidden shrink-0 px-1.5 py-0 text-[10px] md:inline-flex"
            >
              {t("suggestion.confidence", { percent: Math.round(suggestion.confidence * 100) })}
            </Badge>
            {suggestionOpen && !readOnly && (
              <span className="flex shrink-0 gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-primary hover:bg-primary/10"
                  title={t("suggestion.accept")}
                  aria-label={t("suggestion.accept")}
                  onClick={() => onAccept(item.key)}
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-muted-foreground"
                  title={t("suggestion.reject")}
                  aria-label={t("suggestion.reject")}
                  onClick={() => onReject(item.key)}
                >
                  <X className="size-4" />
                </Button>
              </span>
            )}
          </div>
        ) : fillItem?.status === "failed" ? (
          <Badge variant="danger" className="px-1.5 py-0 text-[10px]">
            {t("suggestion.failed")}
          </Badge>
        ) : fillActive ? (
          <span className="text-[11px] text-muted-foreground">…</span>
        ) : null}
      </div>

      <div className="py-1.5 pr-2" onClick={(event) => event.stopPropagation()}>
        <PriceInput
          value={working?.unitPrice ?? null}
          locale={locale}
          disabled={readOnly}
          tone={decision}
          ariaLabel={`${t("table.unitPrice")} ${item.oz}`}
          onCommit={(value) => onCommitPrice(item.key, value)}
        />
        {item.existingUnitPrice !== null && (
          <p className="mt-0.5 hidden truncate text-right text-[10px] tabular-nums text-muted-foreground md:block">
            {t("table.existingPrice", { price: formatUnitPrice(item.existingUnitPrice, locale) })}
          </p>
        )}
      </div>

      <div className="hidden py-2 pr-3 text-right font-medium tabular-nums md:block">
        {lineTotal !== null ? formatMoney(lineTotal, locale, currency) : ""}
      </div>
    </div>
  );
});
