"use client";

import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import {
  CONTRACT_NATURES,
  DEADLINE_DAY_OPTIONS,
  EMPTY_FILTERS,
  GERMAN_REGION_CODES,
  SECTOR_DIVISIONS,
  activeFilterCount,
  type TenderFilters,
} from "@/lib/tenders/filters";
import { OPPORTUNITY_STATUSES } from "@/lib/tenders/relevance";
import { cn } from "@/lib/utils";

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value)
    ? arr.filter((item) => item !== value)
    : [...arr, value];
}

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

export function TenderFilterBar({
  filters,
  onChange,
  savedSlot,
}: {
  filters: TenderFilters;
  onChange: (next: TenderFilters) => void;
  savedSlot?: ReactNode;
}) {
  const t = useTranslations("Tenders");
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(filters);
  const set = (patch: Partial<TenderFilters>) => onChange({ ...filters, ...patch });
  const matchPercent = Math.round((filters.minScore ?? 0) * 100);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q ?? ""}
            onChange={(event) => set({ q: event.target.value || undefined })}
            placeholder={t("filters.searchPlaceholder")}
            className="h-9 pl-9"
            aria-label={t("filters.searchPlaceholder")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {OPPORTUNITY_STATUSES.map((status) => (
            <Chip
              key={status}
              active={filters.statuses.includes(status)}
              onClick={() => set({ statuses: toggle(filters.statuses, status) })}
            >
              {t(`status.${status}` as "status.OPEN")}
            </Chip>
          ))}
        </div>

        <div className="flex items-center gap-1.5 sm:ml-auto">
          {savedSlot}
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
              count > 0
                ? "border-primary/40 bg-primary/5 text-primary"
                : "border-border bg-background text-foreground hover:bg-muted",
            )}
          >
            <SlidersHorizontal className="size-3.5" />
            {t("filters.button")}
            {count > 0 && (
              <span className="grid size-4 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                {count}
              </span>
            )}
            <ChevronDown
              className={cn("size-3.5 transition-transform", open && "rotate-180")}
            />
          </button>
        </div>
      </div>

      {open && (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-muted/20 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Section title={t("filters.sections.contract")}>
              {CONTRACT_NATURES.map((value) => (
                <Chip
                  key={value}
                  active={filters.contractNatures.includes(value)}
                  onClick={() =>
                    set({ contractNatures: toggle(filters.contractNatures, value) })
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
                  onClick={() => set({ sectors: toggle(filters.sectors, value) })}
                >
                  {t(`sector.${value}` as "sector.45")}
                </Chip>
              ))}
            </Section>

            <Section title={t("filters.sections.region")}>
              {GERMAN_REGION_CODES.map((value) => (
                <Chip
                  key={value}
                  active={filters.regions.includes(value)}
                  onClick={() => set({ regions: toggle(filters.regions, value) })}
                >
                  {t(`region.${value}` as "region.DE1")}
                </Chip>
              ))}
            </Section>
          </div>

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
              onClick={() => onChange({ ...EMPTY_FILTERS })}
              className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
              {t("filters.clearAll")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
