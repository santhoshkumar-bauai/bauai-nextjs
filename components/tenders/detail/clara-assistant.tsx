"use client";

import {
  ChevronDown,
  Expand,
  MessageCircleMore,
  Scale,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { ChatInput } from "@/components/chat/chat-input";
import { MessageList } from "@/components/chat/message-list";
import { useClaraChat } from "@/components/chat/use-clara-chat";
import { cn } from "@/lib/utils";
import { FitSection, type FitSectionProps } from "./ai-tab";

/**
 * Clara — the floating tender assistant. A chat over the tender's structured
 * artifacts and documents, with the company-fit assessment as an expandable
 * quick-action card. The expand button continues the SAME conversation on
 * the full-page chat (shared thread key).
 */
export function ClaraAssistant({
  tenderId,
  fit,
}: {
  tenderId: string | null;
  fit: FitSectionProps;
}) {
  const t = useTranslations("Tenders.chat");
  const tc = useTranslations("Chat");
  const locale = useLocale() as "en" | "de";
  const [open, setOpen] = useState(false);
  const [fitOpen, setFitOpen] = useState(false);
  const chat = useClaraChat(
    open && tenderId ? `/api/tenders/${tenderId}/chat` : null,
    { locale },
  );

  return (
    <div className="absolute right-4 bottom-4 z-20 flex flex-col items-end gap-2">
      {open && (
        <div className="flex h-[560px] max-h-[70vh] w-[380px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Sparkles className="size-3.5 text-primary" />
              {t("title")}
            </span>
            <span className="flex items-center gap-1">
              {tenderId && (
                <Link
                  href={`/chat?tender=${tenderId}`}
                  aria-label={t("openFullWindow")}
                  title={t("openFullWindow")}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Expand className="size-3.5" />
                </Link>
              )}
              {chat.messages.length > 0 && (
                <button
                  type="button"
                  onClick={chat.clear}
                  aria-label={tc("clear")}
                  title={tc("clear")}
                  className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <Trash2 className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t("close")}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
            {/* Quick actions: company fit (expandable) + verdict command. */}
            <div className="mb-3 flex flex-col gap-2">
              <div className="rounded-xl border border-border">
                <button
                  type="button"
                  onClick={() => setFitOpen(!fitOpen)}
                  className="flex w-full items-center justify-between px-3 py-2 text-[11px] font-medium text-foreground hover:bg-muted/40"
                >
                  {tc("fitQuickAction")}
                  <ChevronDown
                    className={cn(
                      "size-3.5 text-muted-foreground transition-transform",
                      fitOpen && "rotate-180",
                    )}
                  />
                </button>
                {fitOpen && (
                  <div className="border-t border-border px-3 py-2">
                    <FitSection {...fit} />
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={chat.requestVerdict}
                disabled={chat.sending}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-[11px] font-medium text-primary hover:bg-primary/10 disabled:opacity-50"
              >
                <Scale className="size-3.5" />
                {tc("verdictQuickAction")}
              </button>
            </div>

            {chat.loading ? (
              <p className="py-6 text-center text-[11px] text-muted-foreground">
                {tc("loading")}
              </p>
            ) : (
              <MessageList
                messages={chat.messages}
                streamingText={chat.streamingText}
                verdicts={chat.verdicts}
                pending={chat.sending}
                activeTool={chat.activeTool}
                activeStage={chat.activeStage}
              />
            )}
            {chat.error && (
              <p className="pt-2 text-center text-[11px] text-rose-600">
                {chat.error === "rate_limited" ? tc("rateLimited") : tc("error")}
              </p>
            )}
          </div>

          <ChatInput
            onSend={chat.send}
            onStop={chat.stop}
            sending={chat.sending}
            disabled={!tenderId}
          />
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={t("title")}
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
