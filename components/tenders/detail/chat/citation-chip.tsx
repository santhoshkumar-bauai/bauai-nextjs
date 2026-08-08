"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import type { WireCitation } from "@/lib/ai/agent/wire";
import { cn } from "@/lib/utils";

/** Numbered citation chips; clicking reveals the verbatim quote + source. */
export function CitationChips({ citations }: { citations: WireCitation[] }) {
  const t = useTranslations("Tenders.chat");
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (citations.length === 0) return null;
  const open = citations.find((citation) => citation.key === openKey);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-1">
        {citations.map((citation, index) => (
          <button
            key={citation.key}
            type="button"
            onClick={() =>
              setOpenKey(openKey === citation.key ? null : citation.key)
            }
            className={cn(
              "rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary",
              openKey === citation.key && "bg-primary/10 text-primary",
            )}
            title={citation.fileName}
          >
            [{index + 1}]
          </button>
        ))}
      </div>
      {open && (
        <blockquote className="rounded-md border-l-2 border-primary/40 bg-muted/40 px-2 py-1.5">
          <p className="text-[11px] italic text-foreground/80">
            {`„${open.quote}“`}
          </p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {t("citationSource")}: {open.fileName}
          </p>
        </blockquote>
      )}
    </div>
  );
}
