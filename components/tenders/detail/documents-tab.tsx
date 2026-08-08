"use client";

import { ExternalLink, FileText, Globe } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { SerializedTenderDetail } from "@/lib/tenders/detail";

export function DocumentsTab({ detail }: { detail: SerializedTenderDetail }) {
  const t = useTranslations("Tenders");

  if (detail.documents.length === 0 && detail.sourceLinks.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t("detail.noDocuments")}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {detail.documents.map((doc, index) => (
        <a
          key={`${doc.url}-${index}`}
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">
              {doc.kind ?? t("detail.document")}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {doc.url}
            </span>
          </span>
          {doc.restricted && (
            <Badge variant="warning" className="shrink-0">
              {t("detail.restricted")}
            </Badge>
          )}
          <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </a>
      ))}
      {detail.sourceLinks
        .filter((link) => link.url)
        .map((link, index) => (
          <a
            key={`${link.url}-${index}`}
            href={link.url as string}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-3 rounded-lg border border-dashed border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
          >
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-foreground">
                {t("detail.sourcePortal")} · {link.source}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {link.url}
              </span>
            </span>
            <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </a>
        ))}
    </div>
  );
}
