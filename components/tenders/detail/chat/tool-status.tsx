"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

/** Transient "what Dora is doing" line — coarse tool labels only (§22.4). */
export function ToolStatus({ activeTool }: { activeTool: string | null }) {
  const t = useTranslations("Tenders.chat.tool");
  if (!activeTool) return null;

  // Unknown tool names fall back to the generic label.
  const key = (
    [
      "get_tender_notice",
      "get_tender_overview",
      "get_extractions",
      "search_tender_documents",
      "get_company_fit",
      "search_company_documents",
      "verdict",
    ] as const
  ).find((name) => name === activeTool);

  return (
    <div className="flex items-center gap-1.5 px-3 pb-1 text-[10px] text-muted-foreground">
      <Loader2 className="size-2.5 animate-spin" />
      {key ? t(key) : t("generic")}
    </div>
  );
}
