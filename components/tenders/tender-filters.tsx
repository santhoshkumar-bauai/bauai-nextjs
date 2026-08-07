"use client";

import { Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export const STATUS_OPTIONS = ["OPEN", "CLOSING_SOON", "UPCOMING"] as const;
export type StatusOption = (typeof STATUS_OPTIONS)[number];

interface TenderFiltersProps {
  q: string;
  onQ: (value: string) => void;
  statuses: StatusOption[];
  onToggleStatus: (status: StatusOption) => void;
  onClear: () => void;
  hasActiveFilters: boolean;
}

export function TenderFilters({
  q,
  onQ,
  statuses,
  onToggleStatus,
  onClear,
  hasActiveFilters,
}: TenderFiltersProps) {
  const t = useTranslations("Tenders");

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="relative sm:max-w-xs sm:flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(event) => onQ(event.target.value)}
          placeholder={t("filters.searchPlaceholder")}
          className="h-9 pl-9"
          aria-label={t("filters.searchPlaceholder")}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_OPTIONS.map((status) => {
          const active = statuses.includes(status);
          return (
            <button
              key={status}
              type="button"
              onClick={() => onToggleStatus(status)}
              aria-pressed={active}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-muted",
              )}
            >
              {t(`status.${status}` as "status.OPEN")}
            </button>
          );
        })}

        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
            {t("filters.clear")}
          </button>
        )}
      </div>
    </div>
  );
}
