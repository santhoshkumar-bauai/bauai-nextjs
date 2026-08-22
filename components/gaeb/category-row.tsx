"use client";

import { ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";

import type { GaebCategory } from "@/lib/gaeb/types";
import { cn } from "@/lib/utils";

import { formatMoney } from "./price-format";

export function CategoryRow({
  category,
  collapsed,
  subtotal,
  itemCount,
  locale,
  currency,
  onToggle,
}: {
  category: GaebCategory;
  collapsed: boolean;
  subtotal: number | null;
  itemCount: number;
  locale: string;
  currency: string;
  onToggle: () => void;
}) {
  const t = useTranslations("Gaeb.table");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className={cn(
        "flex w-full items-center gap-2 border-b border-border bg-muted/40 px-3 py-1.5 text-left",
        "hover:bg-muted/70",
      )}
      style={{ paddingLeft: `${12 + category.depth * 18}px` }}
    >
      <ChevronRight
        className={cn("size-4 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")}
      />
      <span className="w-16 shrink-0 text-[12px] font-medium tabular-nums text-muted-foreground">
        {category.oz}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
        {category.label}
      </span>
      <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
        {t("positions", { count: itemCount })}
      </span>
      <span className="w-28 shrink-0 text-right text-[13px] font-semibold tabular-nums text-foreground">
        {subtotal !== null ? formatMoney(subtotal, locale, currency) : ""}
      </span>
    </button>
  );
}
