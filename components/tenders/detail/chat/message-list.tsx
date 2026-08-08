"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

import type { WireChatMessage, WireVerdict } from "@/lib/ai/agent/wire";
import { cn } from "@/lib/utils";
import { CitationChips } from "./citation-chip";
import { VerdictCard } from "./verdict-card";

function Bubble({
  message,
  verdict,
}: {
  message: WireChatMessage;
  verdict: WireVerdict | undefined;
}) {
  const t = useTranslations("Tenders.chat");
  const isUser = message.role === "user";

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[90%] rounded-2xl px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap",
          isUser
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-muted text-foreground",
          message.status === "error" && "opacity-70",
        )}
      >
        {message.content ||
          (message.status === "error" ? t("errorMessage") : t("aborted"))}
      </div>
      {message.status === "aborted" && message.content && (
        <span className="text-[10px] text-muted-foreground">{t("aborted")}</span>
      )}
      {!isUser && <CitationChips citations={message.citations} />}
      {verdict && <VerdictCard verdict={verdict} />}
    </div>
  );
}

export function MessageList({
  messages,
  streamingText,
  verdicts,
}: {
  messages: WireChatMessage[];
  streamingText: string;
  verdicts: Record<string, WireVerdict>;
}) {
  const t = useTranslations("Tenders.chat");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamingText]);

  return (
    <div className="flex flex-col gap-3">
      {messages.length === 0 && !streamingText && (
        <p className="py-6 text-center text-[11px] text-muted-foreground">
          {t("empty")}
        </p>
      )}
      {messages.map((message) => (
        <Bubble
          key={message.id}
          message={message}
          verdict={
            message.verdictId ? verdicts[message.verdictId] : undefined
          }
        />
      ))}
      {streamingText && (
        <div className="flex items-start">
          <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-foreground">
            {streamingText}
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary/60 align-middle" />
          </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
