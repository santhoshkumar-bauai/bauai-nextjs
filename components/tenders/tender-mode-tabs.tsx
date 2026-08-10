"use client";

import { ListFilter, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export type TenderMode = "ai" | "classic";

/**
 * Switches between the AI-ranked feed and the deterministic one. Styled as the
 * same segmented control as the list/map toggle so the header reads as one set
 * of controls rather than two competing ones.
 */
export function TenderModeTabs({
  mode,
  onChange,
  disabled = false,
}: {
  mode: TenderMode;
  onChange: (mode: TenderMode) => void;
  /** Set when AI matching is switched off or unsupported on this deployment. */
  disabled?: boolean;
}) {
  const t = useTranslations("Tenders.aiMatched.tabs");

  const tabs = [
    { key: "ai" as const, icon: Sparkles, label: t("ai"), hint: t("aiHint") },
    { key: "classic" as const, icon: ListFilter, label: t("classic"), hint: t("classicHint") },
  ];

  return (
    <div
      role="tablist"
      className="inline-flex shrink-0 rounded-lg border border-border bg-background p-0.5"
    >
      {tabs.map((tab) => {
        const active = mode === tab.key;
        const isDisabled = disabled && tab.key === "ai";
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            title={tab.hint}
            disabled={isDisabled}
            onClick={() => onChange(tab.key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              active
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
              isDisabled && "cursor-not-allowed opacity-40 hover:text-muted-foreground",
            )}
          >
            <tab.icon className="size-4" />
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
