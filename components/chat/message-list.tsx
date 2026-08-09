"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

import { FileText, Image as ImageIcon } from "lucide-react";

import type {
  WireAttachment,
  WireChatMessage,
  WireTenderRef,
  WireVerdict,
} from "@/lib/ai/agent/wire";
import { cn } from "@/lib/utils";
import { CitationChips } from "./citation-chip";
import { ChatMarkdown } from "./markdown";
import { TenderRefCards } from "./tender-ref-cards";
import { VerdictCard } from "./verdict-card";

export type ChatDensity = "compact" | "comfortable";

/**
 * Tools with a hand-written progress label. Anything Clara calls that is not
 * listed here still renders, as `tool.generic` — so a new tool degrades to
 * "Working…" rather than crashing the message list on a missing key.
 */
const TOOL_LABEL_KEYS = [
  "get_tender_notice",
  "get_tender_overview",
  "get_extractions",
  "search_tender_documents",
  "list_tender_files",
  "read_tender_document",
  "get_company_fit",
  "search_company_documents",
  "get_company_profile",
  "list_company_documents",
  "find_tenders",
  "get_tender_report",
  "get_tender_verdict",
  "get_tender_analysis_status",
  "find_similar_tenders",
  "compare_tenders",
  "list_relevant_tenders",
  "list_workspace_tenders",
  "list_tender_reports",
  "lookup_cpv_codes",
  "verdict",
] as const;

const VERDICT_STAGES = ["loading_artifacts", "retrieving_gaps", "drafting"] as const;

/**
 * Assistant-style bubble shown while a turn runs and nothing streams yet —
 * most of a turn is model/tool time, and without this the UI looks dead.
 */
function ThinkingIndicator({
  activeTool,
  activeStage,
  density,
}: {
  activeTool: string | null;
  activeStage: string | null;
  density: ChatDensity;
}) {
  const t = useTranslations("Chat");
  const stageKey = VERDICT_STAGES.find((stage) => stage === activeStage);
  const toolKey = TOOL_LABEL_KEYS.find((name) => name === activeTool);
  const label = stageKey
    ? t(`tool.verdictStage.${stageKey}`)
    : toolKey
      ? t(`tool.${toolKey}`)
      : activeTool
        ? t("tool.generic")
        : t("thinking");

  return (
    <div className="flex items-start">
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-2xl rounded-bl-sm bg-muted text-muted-foreground",
          density === "comfortable"
            ? "px-4 py-3 text-sm"
            : "px-3 py-2 text-xs",
        )}
      >
        <span className="flex items-center gap-1">
          {[0, 150, 300].map((delay) => (
            <span
              key={delay}
              className="size-1.5 animate-bounce rounded-full bg-primary/60"
              style={{ animationDelay: `${delay}ms` }}
            />
          ))}
        </span>
        {label}
      </div>
    </div>
  );
}

function AttachmentChips({ attachments }: { attachments: WireAttachment[] }) {
  const t = useTranslations("Chat");
  return (
    <div className="flex max-w-[90%] flex-wrap justify-end gap-1.5">
      {attachments.map((attachment, index) => (
        <span
          key={`${attachment.fileName}-${index}`}
          className={cn(
            "flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-foreground",
            attachment.status !== "ready" && "opacity-60",
          )}
          title={
            attachment.status === "ready"
              ? attachment.fileName
              : `${attachment.fileName} — ${t("attach.unsupported")}`
          }
        >
          {attachment.contentType.startsWith("image/") ? (
            <ImageIcon className="size-3 text-muted-foreground" />
          ) : (
            <FileText className="size-3 text-muted-foreground" />
          )}
          <span className="max-w-44 truncate">{attachment.fileName}</span>
        </span>
      ))}
    </div>
  );
}

function Bubble({
  message,
  verdict,
  density,
}: {
  message: WireChatMessage;
  verdict: WireVerdict | undefined;
  density: ChatDensity;
}) {
  const t = useTranslations("Chat");
  const isUser = message.role === "user";
  const hasAttachments = (message.attachments?.length ?? 0) > 0;
  // Attachment-only user messages have no text — chips alone, no empty bubble.
  const showBubble = Boolean(message.content) || !isUser;

  return (
    <div className={cn("flex flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
      {hasAttachments && <AttachmentChips attachments={message.attachments!} />}
      {showBubble && (
        <div
          className={cn(
            "max-w-[90%] rounded-2xl",
            isUser && "whitespace-pre-wrap",
            density === "comfortable"
              ? "px-4 py-2.5 text-sm leading-relaxed"
              : "px-3 py-2 text-xs leading-relaxed",
            isUser
              ? "rounded-br-sm bg-primary text-primary-foreground"
              : "rounded-bl-sm bg-muted text-foreground",
            message.status === "error" && "opacity-70",
          )}
        >
          {message.content ? (
            isUser ? (
              message.content
            ) : (
              <ChatMarkdown text={message.content} />
            )
          ) : message.status === "aborted" ? (
            t("aborted")
          ) : (
            t("errorMessage")
          )}
        </div>
      )}
      {message.status === "aborted" && message.content && (
        <span className="text-[10px] text-muted-foreground">{t("aborted")}</span>
      )}
      {!isUser && <CitationChips citations={message.citations} />}
      {!isUser && (
        <TenderRefCards refs={message.tenderRefs} density={density} />
      )}
      {verdict && <VerdictCard verdict={verdict} />}
    </div>
  );
}

export function MessageList({
  messages,
  streamingText,
  verdicts,
  density = "compact",
  emptyText,
  pending = false,
  activeTool = null,
  activeStage = null,
  liveTenderRefs = [],
}: {
  messages: WireChatMessage[];
  streamingText: string;
  verdicts: Record<string, WireVerdict>;
  density?: ChatDensity;
  /** Overrides the default empty-state line (e.g. global-chat wording). */
  emptyText?: string;
  /** True while a turn runs — shows the thinking indicator until text streams. */
  pending?: boolean;
  activeTool?: string | null;
  activeStage?: string | null;
  /**
   * Tenders the running turn has surfaced so far. Shown while the turn is in
   * flight; the finished message carries the same list persistently.
   */
  liveTenderRefs?: WireTenderRef[];
}) {
  const t = useTranslations("Chat");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, streamingText, pending]);

  return (
    <div className="flex flex-col gap-3">
      {messages.length === 0 && !streamingText && (
        <p
          className={cn(
            "py-6 text-center text-muted-foreground",
            density === "comfortable" ? "text-sm" : "text-[11px]",
          )}
        >
          {emptyText ?? t("empty")}
        </p>
      )}
      {messages.map((message) => (
        <Bubble
          key={message.id}
          message={message}
          density={density}
          verdict={
            message.verdictId ? verdicts[message.verdictId] : undefined
          }
        />
      ))}
      {streamingText && (
        <div className="flex items-start">
          <div
            className={cn(
              "max-w-[90%] rounded-2xl rounded-bl-sm bg-muted text-foreground",
              density === "comfortable"
                ? "px-4 py-2.5 text-sm leading-relaxed"
                : "px-3 py-2 text-xs leading-relaxed",
            )}
          >
            <ChatMarkdown text={streamingText} />
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-primary/60 align-middle" />
          </div>
        </div>
      )}
      {pending && !streamingText && (
        <ThinkingIndicator
          activeTool={activeTool}
          activeStage={activeStage}
          density={density}
        />
      )}
      {(pending || streamingText !== "") && liveTenderRefs.length > 0 && (
        <TenderRefCards refs={liveTenderRefs} density={density} />
      )}
      <div ref={bottomRef} />
    </div>
  );
}
