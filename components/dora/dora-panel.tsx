"use client";

import Image from "next/image";
import { RefreshCw, Trash2, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ChatInput } from "@/components/chat/chat-input";
import { MessageList } from "@/components/chat/message-list";
import { useClaraChat } from "@/components/chat/use-clara-chat";
import { BriefSection } from "./brief-section";
import { useDoraBrief } from "./use-dora-brief";
import { useAiErrorMessage } from "../chat/use-ai-error-message";

/**
 * Dora — the document assistant panel beside the ONLYOFFICE editor. Brief on
 * top (auto-generated, staged progress, resumable), free chat below. Chat
 * reuses Clara's endpoint-parameterized hook + components against the Dora
 * routes; the agent behind them is Dora's LangGraph tool loop.
 */
export function DoraPanel({
  documentId,
  aiAvailable,
  onClose,
}: {
  documentId: string;
  aiAvailable: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("Dora");
  const aiErrorMessage = useAiErrorMessage();
  const locale = useLocale() as "en" | "de";
  const chat = useClaraChat(`/api/workspace-documents/${documentId}/dora/chat`, {
    locale,
  });
  const brief = useDoraBrief(documentId, aiAvailable);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
        <Image
          src="/agents/dora.svg"
          alt=""
          width={24}
          height={24}
          className="size-6 rounded-full"
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-foreground">
            {t("title")}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {t("subtitle")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => brief.generate(true)}
          disabled={!aiAvailable || brief.running}
          title={t("analyzeLatest")}
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={brief.running ? "size-3 animate-spin" : "size-3"} />
          {t("analyzeLatest")}
        </button>
        {chat.messages.length > 0 && (
          <button
            type="button"
            onClick={chat.clear}
            aria-label={t("clearChat")}
            title={t("clearChat")}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("close")}
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <BriefSection
          status={brief.status}
          error={brief.error}
          running={brief.running}
          aiAvailable={aiAvailable}
          onGenerate={(refresh) => void brief.generate(refresh)}
        />

        <div className="mt-3">
          {chat.loading ? (
            <p className="py-4 text-center text-[11px] text-muted-foreground">
              {t("chatLoading")}
            </p>
          ) : chat.messages.length === 0 && !chat.sending ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[11px] text-muted-foreground">
              {t("chatEmpty")}
            </p>
          ) : (
            <MessageList
              messages={chat.messages}
              streamingText={chat.streamingText}
              verdicts={chat.verdicts}
              pending={chat.sending}
              activeTool={chat.activeTool}
              activeStage={chat.activeStage}
              liveTenderRefs={chat.tenderRefs}
              thinkingText={t("thinking")}
            />
          )}
          {chat.error && (
            <p className="pt-2 text-center text-[11px] text-rose-600">
              {aiErrorMessage(chat.error)}
            </p>
          )}
        </div>
      </div>

      <ChatInput
        onSend={chat.send}
        onStop={chat.stop}
        sending={chat.sending}
        disabled={!aiAvailable}
        allowAttachments={false}
        placeholder={t("placeholder")}
      />
    </div>
  );
}
