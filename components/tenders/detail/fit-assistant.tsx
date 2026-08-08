"use client";

import { MessageCircleMore, X } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import { FitSection, type FitSectionProps } from "./ai-tab";

/**
 * Floating chat-style widget hosting the company-fit assessment — the seat
 * where the Dora chat agent will live later. Anchored bottom-right of the
 * tender dialog.
 */
export function FitAssistant(props: FitSectionProps) {
  const t = useTranslations("Tenders.recommendation");
  const [open, setOpen] = useState(false);

  return (
    <div className="absolute right-4 bottom-4 z-20 flex flex-col items-end gap-2">
      {open && (
        <div className="flex max-h-[420px] w-[360px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-xs font-semibold text-foreground">
              {t("assistantTitle")}
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("assistantClose")}
              className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <FitSection {...props} />
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("assistantTitle")}
        className={cn(
          "grid size-11 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg transition-transform hover:scale-105",
          open && "scale-95 opacity-90",
        )}
      >
        <MessageCircleMore className="size-5" />
      </button>
    </div>
  );
}
