"use client";

import Link from "next/link";
import { ArrowLeft, FileEdit, MessageSquareText, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * PDF entry chooser: a PDF in the document filler can open in the AI fill
 * chat or straight in the ONLYOFFICE editor. Everything else keeps its
 * direct path (word/cell → editor, gaeb → BOQ workspace).
 */
export function DocumentOpenChooser({
  documentId,
  fileName,
  aiAvailable,
}: {
  documentId: string;
  fileName: string;
  aiAvailable: boolean;
}) {
  const t = useTranslations("FillAgent");

  return (
    <main className="flex h-svh min-h-0 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
        <Link
          href="/document-filler"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("chooserBack")}
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-foreground">{fileName}</h1>
          <p className="truncate text-[11px] text-muted-foreground">
            {t("chooserSubtitle")}
          </p>
        </div>
      </header>

      <div className="flex flex-1 items-center justify-center p-6">
        <div className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
          <Link
            href={aiAvailable ? `/document-filler/${documentId}/chat` : "#"}
            aria-disabled={!aiAvailable}
            className={`group flex flex-col gap-3 rounded-2xl border border-border p-5 transition-colors ${
              aiAvailable
                ? "hover:border-primary hover:bg-primary/5"
                : "pointer-events-none opacity-50"
            }`}
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <MessageSquareText className="size-5" />
            </span>
            <span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                {t("chooserChat")}
                <Sparkles className="size-3.5 text-primary" />
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {aiAvailable ? t("chooserChatHint") : t("noProvider")}
              </span>
            </span>
          </Link>

          <Link
            href={`/document-filler/${documentId}?mode=editor`}
            className="group flex flex-col gap-3 rounded-2xl border border-border p-5 transition-colors hover:border-primary hover:bg-primary/5"
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground">
              <FileEdit className="size-5" />
            </span>
            <span>
              <span className="block text-sm font-semibold text-foreground">
                {t("chooserEditor")}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {t("chooserEditorHint")}
              </span>
            </span>
          </Link>
        </div>
      </div>
    </main>
  );
}
