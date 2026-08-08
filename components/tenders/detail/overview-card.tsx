"use client";

import {
  AlertTriangle,
  Building2,
  CalendarRange,
  ClipboardCheck,
  Info,
  ListChecks,
  Wrench,
} from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { OverviewView } from "./use-extractions";

/**
 * Tender-centric AI overview: what it's about, the scope, the buyer, risks
 * and highlights. Content is stored in both languages; the active locale
 * decides which one renders.
 */
export function OverviewCard({ view }: { view: OverviewView }) {
  const t = useTranslations("Tenders.ai.overview");
  const format = useFormatter();
  const locale = useLocale();

  const content = locale === "de" ? view.overview.de : view.overview.en;

  const textBlocks = [
    { key: "about", icon: Info, text: content.about },
    { key: "scope", icon: Wrench, text: content.scope },
    { key: "buyer", icon: Building2, text: content.buyer },
    { key: "timeline", icon: CalendarRange, text: content.timeline },
    { key: "requirements", icon: ClipboardCheck, text: content.requirements },
  ] as const;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      {textBlocks.map(
        ({ key, icon: Icon, text }) =>
          text && (
            <div key={key} className="flex flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
                <Icon className="size-3" />
                {t(key)}
              </span>
              <p className="text-xs leading-relaxed whitespace-pre-line text-foreground/90">
                {text}
              </p>
            </div>
          ),
      )}

      {content.risks.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-700">
            <AlertTriangle className="size-3" />
            {t("risks")}
          </span>
          <ul className="flex flex-col gap-1">
            {content.risks.map((risk, index) => (
              <li key={index} className="flex items-start gap-1.5 text-xs text-foreground/90">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500" />
                {risk}
              </li>
            ))}
          </ul>
        </div>
      )}

      {content.highlights.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
            <ListChecks className="size-3" />
            {t("highlights")}
          </span>
          <ul className="flex flex-col gap-1">
            {content.highlights.map((highlight, index) => (
              <li key={index} className="flex items-start gap-1.5 text-xs text-foreground/90">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary/60" />
                {highlight}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
        <Badge variant={view.sourceChunkCount > 0 ? "info" : "neutral"}>
          {view.sourceChunkCount > 0
            ? t("withDocuments", { count: view.sourceChunkCount })
            : t("noticeOnly")}
        </Badge>
        {view.generatedAt && (
          <span>
            {format.dateTime(new Date(view.generatedAt), {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
