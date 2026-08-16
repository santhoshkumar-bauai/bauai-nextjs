"use client";

import {
  ArrowUpDown,
  ChevronDown,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CONTRACT_NATURES,
  DEADLINE_DAY_OPTIONS,
  DEFAULT_SORT,
  EMPTY_FILTERS,
  GERMAN_REGION_CODES,
  SECTOR_DIVISIONS,
  SORT_OPTIONS,
  activeFilterChips,
  activeFilterCount,
  removeFilterChip,
  type ActiveFilterChip,
  type TenderFilters,
} from "@/lib/tenders/filters";
import { OPPORTUNITY_STATUSES } from "@/lib/tenders/relevance";
import { cn } from "@/lib/utils";

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value)
    ? arr.filter((item) => item !== value)
    : [...arr, value];
}

/** Shared look for the three popover triggers, so the row reads as one control. */
const triggerClass =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted data-[popup-open]:bg-muted";

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

export function TenderToolbar({
  filters,
  onChange,
  leadingSlot,
  viewSlot,
  savedSlot,
  trailingSlot,
}: {
  filters: TenderFilters;
  onChange: (next: TenderFilters) => void;
  /** Rendered first in the row — the region pill. */
  leadingSlot?: ReactNode;
  /** Between Sort and Filters — the list/map switch. */
  viewSlot?: ReactNode;
  /** After Filters — saved presets. */
  savedSlot?: ReactNode;
  /** Pushed to the far end, left of the search control. */
  trailingSlot?: ReactNode;
}) {
  const t = useTranslations("Tenders");
  const searchRef = useRef<HTMLInputElement>(null);
  // The search field is collapsed to its icon until asked for, so the row reads
  // as one line of controls; an active query keeps it open.
  const [searchOpen, setSearchOpen] = useState(Boolean(filters.q));
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const count = activeFilterCount(filters);
  const chips = activeFilterChips(filters);
  const set = (patch: Partial<TenderFilters>) =>
    onChange({ ...filters, ...patch });
  const matchPercent = Math.round((filters.minScore ?? 0) * 100);
  const sort = filters.sort ?? DEFAULT_SORT;

  // Chip labels live here rather than in the filter model, which has no `t`.
  const chipLabel = (chip: ActiveFilterChip): string => {
    switch (chip.field) {
      case "q":
        return `${t("filters.chips.search")}: ${filters.q}`;
      case "deadlineInDays":
        return `${t("filters.sections.deadline")}: ${t("filters.deadlineDays", { days: filters.deadlineInDays ?? 0 })}`;
      case "minScore":
        return `${t("filters.sections.match")}: ${t("filters.matchValue", { percent: matchPercent })}`;
      case "statuses":
        return t(`status.${chip.value}` as "status.OPEN");
      case "contractNatures":
        return t(`contract.${chip.value}` as "contract.works");
      case "sectors":
        return t(`sector.${chip.value}` as "sector.45");
      case "regions":
        return t(`region.${chip.value}` as "region.DE1");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {leadingSlot}

        {/* Sort */}
        <Popover>
          <PopoverTrigger className={triggerClass}>
            <ArrowUpDown className="size-3.5 text-muted-foreground" />
            {t("sort.button")}
            <span className="text-muted-foreground">
              {t(`sort.options.${sort}` as "sort.options.relevance")}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56">
            <div className="flex flex-col gap-0.5">
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => set({ sort: option })}
                  className={cn(
                    "rounded-lg px-3 py-2 text-left text-xs transition-colors hover:bg-muted",
                    option === sort
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {t(`sort.options.${option}` as "sort.options.relevance")}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>

        {viewSlot}

        {/* Filters */}
        <Popover>
          <PopoverTrigger
            className={cn(
              triggerClass,
              count > 0 && "border-primary/40 bg-primary/5 text-primary",
            )}
          >
            <SlidersHorizontal className="size-3.5" />
            {t("filters.button")}
            {count > 0 && (
              <span className="grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                {count}
              </span>
            )}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex w-[min(560px,calc(100vw-2rem))] flex-col gap-4 p-4"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Section title={t("filters.sections.status")}>
                {OPPORTUNITY_STATUSES.map((status) => (
                  <Chip
                    key={status}
                    active={filters.statuses.includes(status)}
                    onClick={() =>
                      set({ statuses: toggle(filters.statuses, status) })
                    }
                  >
                    {t(`status.${status}` as "status.OPEN")}
                  </Chip>
                ))}
              </Section>

              <Section title={t("filters.sections.contract")}>
                {CONTRACT_NATURES.map((value) => (
                  <Chip
                    key={value}
                    active={filters.contractNatures.includes(value)}
                    onClick={() =>
                      set({
                        contractNatures: toggle(filters.contractNatures, value),
                      })
                    }
                  >
                    {t(`contract.${value}` as "contract.works")}
                  </Chip>
                ))}
              </Section>

              <Section title={t("filters.sections.deadline")}>
                <Chip
                  active={!filters.deadlineInDays}
                  onClick={() => set({ deadlineInDays: undefined })}
                >
                  {t("filters.deadlineAny")}
                </Chip>
                {DEADLINE_DAY_OPTIONS.map((days) => (
                  <Chip
                    key={days}
                    active={filters.deadlineInDays === days}
                    onClick={() => set({ deadlineInDays: days })}
                  >
                    {t("filters.deadlineDays", { days })}
                  </Chip>
                ))}
              </Section>

              <Section title={t("filters.sections.sector")}>
                {SECTOR_DIVISIONS.map((value) => (
                  <Chip
                    key={value}
                    active={filters.sectors.includes(value)}
                    onClick={() =>
                      set({ sectors: toggle(filters.sectors, value) })
                    }
                  >
                    {t(`sector.${value}` as "sector.45")}
                  </Chip>
                ))}
              </Section>
            </div>

            <Section title={t("filters.sections.region")}>
              {GERMAN_REGION_CODES.map((value) => (
                <Chip
                  key={value}
                  active={filters.regions.includes(value)}
                  onClick={() =>
                    set({ regions: toggle(filters.regions, value) })
                  }
                >
                  {t(`region.${value}` as "region.DE1")}
                </Chip>
              ))}
            </Section>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("filters.sections.match")}
                {matchPercent > 0 && (
                  <span className="ml-1.5 text-primary">
                    {t("filters.matchValue", { percent: matchPercent })}
                  </span>
                )}
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={matchPercent}
                onChange={(event) => {
                  const percent = Number(event.target.value);
                  set({ minScore: percent > 0 ? percent / 100 : undefined });
                }}
                className="h-1.5 w-full max-w-xs cursor-pointer accent-primary"
                aria-label={t("filters.sections.match")}
              />
            </div>

            {count > 0 && (
              <button
                type="button"
                onClick={() =>
                  onChange({ ...EMPTY_FILTERS, sort: filters.sort })
                }
                className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
                {t("filters.clearAll")}
              </button>
            )}
          </PopoverContent>
        </Popover>

        {savedSlot}

        <div className="ml-auto flex items-center gap-1.5">
          {trailingSlot}

          {/* Search — an icon until it is wanted, then an inline field. */}
          {searchOpen ? (
            <div className="relative w-[200px] sm:w-[240px]">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={searchRef}
                value={filters.q ?? ""}
                onChange={(event) =>
                  set({ q: event.target.value || undefined })
                }
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  set({ q: undefined });
                  setSearchOpen(false);
                }}
                placeholder={t("filters.searchPlaceholder")}
                aria-label={t("filters.searchPlaceholder")}
                className="h-9 rounded-lg pr-8 pl-9 text-xs"
              />
              <button
                type="button"
                onClick={() => {
                  set({ q: undefined });
                  setSearchOpen(false);
                }}
                aria-label={t("filters.clear")}
                className="absolute top-1/2 right-2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              aria-label={t("filters.searchPlaceholder")}
              title={t("filters.searchPlaceholder")}
              className={cn(triggerClass, "size-9 justify-center px-0")}
            >
              <Search className="size-4 text-muted-foreground" />
            </button>
          )}
        </div>
      </div>

      {/* Applied filters — each value removable on its own. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t("filters.applied")}
            <span className="grid size-[18px] place-items-center rounded-full bg-muted text-[10px] font-semibold text-foreground">
              {count}
            </span>
          </span>
          <span className="h-4 w-px bg-border" />
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1 pr-1.5 pl-3 text-[11px] text-foreground shadow-xs"
            >
              <span className="max-w-[220px] truncate">{chipLabel(chip)}</span>
              <button
                type="button"
                onClick={() => onChange(removeFilterChip(filters, chip))}
                aria-label={t("filters.removeChip", { label: chipLabel(chip) })}
                className="grid size-4 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <button
              type="button"
              onClick={() => onChange({ ...EMPTY_FILTERS, sort: filters.sort })}
              className="text-[11px] font-medium text-primary hover:underline"
            >
              {t("filters.clearAll")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
