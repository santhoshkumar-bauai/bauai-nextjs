"use client";

import { Search } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type GaebFilterKey =
  | "all"
  | "unpriced"
  | "suggested"
  | "accepted"
  | "edited"
  | "rejected"
  | "failed";

const FILTERS: GaebFilterKey[] = [
  "all",
  "unpriced",
  "suggested",
  "accepted",
  "edited",
  "rejected",
  "failed",
];

export function ReviewToolbar({
  filter,
  counts,
  search,
  bulkVisibleCount,
  bulkConfidentCount,
  onFilterChange,
  onSearchChange,
  onExpandAll,
  onCollapseAll,
  onBulkAcceptVisible,
  onBulkAcceptConfident,
}: {
  filter: GaebFilterKey;
  counts: Record<GaebFilterKey, number>;
  search: string;
  bulkVisibleCount: number;
  bulkConfidentCount: number;
  onFilterChange: (filter: GaebFilterKey) => void;
  onSearchChange: (search: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onBulkAcceptVisible: () => void;
  onBulkAcceptConfident: () => void;
}) {
  const t = useTranslations("Gaeb");

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-white px-3 py-2">
      <div className="flex flex-wrap items-center gap-1">
        {FILTERS.map((key) => {
          const count = counts[key];
          if (key !== "all" && count === 0) return null;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onFilterChange(key)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
                filter === key
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted/60",
              )}
            >
              {t(`filters.${key}`)}
              <span className="ml-1 tabular-nums opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="relative ml-auto w-full max-w-56">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={t("filters.search")}
          className="h-8 w-full rounded-md border border-border bg-white pl-7 pr-2 text-[12px] outline-none focus:border-primary/50 focus:ring-2 focus:ring-primary/15"
        />
      </div>

      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" className="text-[11px]" onClick={onExpandAll}>
          {t("table.expandAll")}
        </Button>
        <Button variant="ghost" size="sm" className="text-[11px]" onClick={onCollapseAll}>
          {t("table.collapseAll")}
        </Button>
      </div>

      {(bulkVisibleCount > 0 || bulkConfidentCount > 0) && (
        <div className="flex w-full items-center gap-2 border-t border-border/60 pt-2 sm:w-auto sm:border-t-0 sm:pt-0">
          {bulkVisibleCount > 0 && (
            <Button variant="outline" size="sm" className="text-[11px]" onClick={onBulkAcceptVisible}>
              {t("bulk.acceptVisible", { count: bulkVisibleCount })}
            </Button>
          )}
          {bulkConfidentCount > 0 && (
            <Button variant="outline" size="sm" className="text-[11px]" onClick={onBulkAcceptConfident}>
              {t("bulk.acceptConfident", { count: bulkConfidentCount, percent: 80 })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
