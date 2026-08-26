"use client";

import { FileSpreadsheet, FileText, FileType, Quote, Search, Sparkle } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BlockPayload } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

import { BlockShell } from "../block-shell";
import { BlockEmpty } from "../primitives";
import { useIrisActions } from "../iris-context";

/**
 * The document family: what exists, and what it says.
 *
 * `document-shelf` answers "what is this analysis actually based on" — a
 * question the product has to be able to answer honestly, because half the
 * time the answer is "four PDFs, one of which is a scan we cannot read".
 * `evidence-panel` is the citation surface: the quote sits next to the claim
 * instead of behind a footnote.
 */

// ---------------------------------------------------------------------------
// Shelf
// ---------------------------------------------------------------------------

function fileIcon(mimeType: string | null | undefined, fileName: string) {
  const name = fileName.toLowerCase();
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) {
    return FileSpreadsheet;
  }
  if (mimeType?.includes("pdf") || name.endsWith(".pdf")) return FileType;
  return FileText;
}

function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function DocumentShelfBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"document-shelf">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const format = useFormatter();
  const [expanded, setExpanded] = useState(false);

  const COLLAPSED = 6;
  const shown = expanded ? block.items : block.items.slice(0, COLLAPSED);
  const hidden = block.items.length - shown.length;

  return (
    <BlockShell
      kind="document-shelf"
      blockId={blockId}
      title={block.title}
      caption={block.caption}
      actions={
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {block.items.length}
        </span>
      }
      bare
    >
      {block.items.length === 0 ? (
        <div className="p-4">
          <BlockEmpty message={t("noDocuments")} />
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border/70">
            {shown.map((item) => {
              const Icon = fileIcon(item.mimeType, item.fileName);
              const size = formatBytes(item.sizeBytes);
              return (
                <li key={item.fileName} className="flex items-center gap-3 px-4 py-2.5">
                  <span
                    className={cn(
                      "grid size-8 shrink-0 place-items-center rounded-lg",
                      item.readable === false
                        ? "bg-muted text-muted-foreground"
                        : "bg-primary/8 text-primary",
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{item.fileName}</p>
                    <p className="flex flex-wrap items-center gap-x-2 text-[10px] text-muted-foreground">
                      {item.docClass ? <span>{item.docClass}</span> : null}
                      {size ? <span className="tabular-nums">{size}</span> : null}
                      {item.updatedAt ? (
                        <span>
                          {format.dateTime(new Date(item.updatedAt), { dateStyle: "short" })}
                        </span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {/*
                      Two different failures with two different fixes: a file we
                      could not extract text from needs OCR, a file that is not
                      indexed just has not been embedded yet. Collapsing them
                      into one "unavailable" chip loses the fix.
                    */}
                    {item.readable === false ? (
                      <Badge variant="warning">{t("notReadable")}</Badge>
                    ) : null}
                    {item.indexed ? (
                      <Badge variant="info">
                        <Sparkle />
                        {t("indexed")}
                      </Badge>
                    ) : (
                      <Badge variant="neutral">{t("notIndexed")}</Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {hidden > 0 || expanded ? (
            <div className="border-t border-border/70 px-4 py-2">
              <button
                type="button"
                onClick={() => setExpanded(!expanded)}
                className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-primary"
              >
                {expanded ? t("showLess") : t("showMore", { count: hidden })}
              </button>
            </div>
          ) : null}
        </>
      )}
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export function EvidencePanelBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"evidence-panel">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const { sendPrompt, isStreaming } = useIrisActions();

  return (
    <BlockShell
      kind="evidence-panel"
      blockId={blockId}
      title={block.title}
      caption={block.query ? `“${block.query}”` : null}
      actions={
        <Badge variant="neutral">
          <Search />
          {t(`scope.${block.scope}` as "scope.tender")}
        </Badge>
      }
    >
      {block.items.length === 0 ? (
        <BlockEmpty message={t("noEvidence")} />
      ) : (
        <ul className="space-y-2.5">
          {block.items.map((item, index) => (
            <li
              key={`${item.fileName}-${index}`}
              className="rounded-xl border border-border bg-muted/25 p-3 transition-colors hover:border-primary/30"
            >
              <blockquote className="text-xs leading-relaxed text-foreground">
                <Quote className="mr-1 inline size-3 -translate-y-px text-primary/50" />
                {item.quote}
              </blockquote>
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-[10px] font-medium text-muted-foreground">
                  {item.fileName}
                </span>
                {item.page != null ? (
                  <Badge variant="neutral">{t("page", { page: item.page })}</Badge>
                ) : null}
                {item.sectionPath && item.sectionPath.length > 0 ? (
                  <span className="truncate text-[10px] text-muted-foreground">
                    {item.sectionPath.join(" › ")}
                  </span>
                ) : null}
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto text-[10px] text-muted-foreground"
                  disabled={isStreaming}
                  onClick={() => sendPrompt(t("explainPrompt", { quote: item.quote.slice(0, 120) }))}
                >
                  {t("whatDoesThisMean")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </BlockShell>
  );
}
