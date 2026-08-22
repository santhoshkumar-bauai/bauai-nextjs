"use client";

import { FileOutput, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { GaebTotals } from "@/lib/gaeb/totals";

import { formatMoney } from "./price-format";

export function TotalsBar({
  totals,
  vatRate,
  locale,
  currency,
  readOnly,
  exportBusy,
  onExport,
}: {
  totals: GaebTotals | null;
  vatRate: number | null;
  locale: string;
  currency: string;
  readOnly: boolean;
  exportBusy: boolean;
  onExport: () => void;
}) {
  const t = useTranslations("Gaeb.totals");
  if (!totals) return null;
  const exportBlocked = totals.unpricedCount > 0;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border bg-white px-4 py-2.5">
      <p
        className={
          totals.unpricedCount > 0
            ? "text-[12px] font-medium text-amber-700"
            : "text-[12px] text-muted-foreground"
        }
      >
        {totals.unpricedCount > 0
          ? t("unpriced", { count: totals.unpricedCount })
          : t("allPriced")}
      </p>

      <div className="ml-auto flex items-center gap-5 text-[13px]">
        <span className="text-muted-foreground">
          {t("net")}{" "}
          <strong className="ml-1 tabular-nums text-foreground">
            {formatMoney(totals.net, locale, currency)}
          </strong>
        </span>
        {vatRate !== null && (
          <span className="hidden text-muted-foreground sm:inline">
            {t("vat", { rate: vatRate })}{" "}
            <strong className="ml-1 tabular-nums text-foreground">
              {formatMoney(totals.vat, locale, currency)}
            </strong>
          </span>
        )}
        <span className="text-muted-foreground">
          {t("gross")}{" "}
          <strong className="ml-1 tabular-nums text-foreground">
            {formatMoney(totals.gross, locale, currency)}
          </strong>
        </span>
      </div>

      {!readOnly && (
        <Button
          size="sm"
          disabled={exportBlocked || exportBusy}
          title={exportBlocked ? t("exportBlocked") : undefined}
          onClick={onExport}
        >
          {exportBusy ? <Loader2 className="animate-spin" /> : <FileOutput />}
          {t("export")}
        </Button>
      )}
    </div>
  );
}
