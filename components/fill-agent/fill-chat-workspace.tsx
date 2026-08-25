"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ChatInput } from "@/components/chat/chat-input";
import { MessageList } from "@/components/chat/message-list";
import { useClaraChat } from "@/components/chat/use-clara-chat";
import { LiveActivityTrail, MessageSteps } from "./activity-trail";
import { PdfPreview } from "./pdf-preview";
import { SessionStatus } from "./session-status";
import { useFillSession } from "./use-fill-session";
import { ValuesForm } from "./values-form";

/**
 * The fill-agent workspace: chat on the left (Clara's endpoint-parameterized
 * hook + components against the POC routes), server-truth status + page
 * preview on the right.
 *
 * ChatGPT-style working transparency: while a turn runs, the live activity
 * trail lists the tool steps as they happen; once the answer lands, its
 * persisted toolEvents render as a collapsed steps summary.
 *
 * Generative gap-filling: whenever the analysis leaves open questions, a
 * form card appears in the chat column — fill some/all or skip; submits go
 * through the same ratcheted server path as the chat tool, then a short
 * auto-message hands control back to the agent.
 */
export function FillChatWorkspace({
  sessionId,
  aiAvailable,
}: {
  sessionId: string;
  aiAvailable: boolean;
}) {
  const t = useTranslations("FillAgent");
  const locale = useLocale() as "en" | "de";
  const chat = useClaraChat(`/api/poc/fill-chat/${sessionId}/chat`, { locale });
  const { session, refresh, refreshKey } = useFillSession(sessionId);

  // ---- live activity trail: accumulate activeTool transitions per turn ----
  const [trail, setTrail] = useState<string[]>([]);
  const lastToolRef = useRef<string | null>(null);
  useEffect(() => {
    if (!chat.sending) {
      lastToolRef.current = null;
      return;
    }
    const tool = chat.activeTool;
    if (tool && tool !== lastToolRef.current) {
      lastToolRef.current = tool;
      setTrail((prev) => [...prev, tool]);
    }
  }, [chat.activeTool, chat.sending]);
  const sendingRef = useRef(false);
  useEffect(() => {
    if (chat.sending && !sendingRef.current) setTrail([]); // new turn
    sendingRef.current = chat.sending;
  }, [chat.sending]);

  // Turn boundary: the send flag flipping off means tools may have moved
  // score/budget/output — re-pull the panel's truth.
  useEffect(() => {
    if (!chat.sending) void refresh();
  }, [chat.sending, refresh]);
  useEffect(() => {
    if (!chat.sending) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [chat.sending, refresh]);

  // ---- values form: session-state driven, dismissible per question-set ----
  const [dismissedFormKey, setDismissedFormKey] = useState<string | null>(null);
  const openQuestions = useMemo(
    () => session?.openQuestions ?? [],
    [session?.openQuestions],
  );
  const formKey = openQuestions.map((question) => question.fieldId).join("|");
  const showForm =
    aiAvailable &&
    !chat.sending &&
    session != null &&
    session.status !== "filled" &&
    openQuestions.some((question) => question.reason !== "sensitive") &&
    dismissedFormKey !== formKey;

  const lastAssistant = [...chat.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Link
          href="/poc/fill-chat"
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {session?.fileName ?? t("title")}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">{t("subtitle")}</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col border-r border-border">
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {!aiAvailable ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                {t("noProvider")}
              </p>
            ) : chat.loading ? (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {t("chatLoading")}
              </p>
            ) : chat.messages.length === 0 && !chat.sending ? (
              <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                {t("chatEmpty")}
              </p>
            ) : (
              <>
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
                {!chat.sending && lastAssistant && (
                  <MessageSteps toolEvents={lastAssistant.toolEvents} />
                )}
              </>
            )}
            {chat.sending && (
              <LiveActivityTrail steps={trail} activeTool={chat.activeTool} />
            )}
            {chat.error && (
              <p className="pt-2 text-center text-xs text-rose-600">
                {chat.error === "rate_limited" ? t("rateLimited") : t("chatError")}
              </p>
            )}
          </div>

          {showForm && (
            <div className="shrink-0 border-t border-border px-4 py-3">
              <ValuesForm
                sessionId={sessionId}
                questions={openQuestions}
                onApplied={(count) => {
                  setDismissedFormKey(null);
                  void refresh();
                  chat.send(t("formContinueMessage", { count }));
                }}
                onSkipped={() => {
                  setDismissedFormKey(formKey);
                  chat.send(t("formSkipMessage"));
                }}
              />
            </div>
          )}

          <ChatInput
            onSend={chat.send}
            onStop={chat.stop}
            sending={chat.sending}
            disabled={!aiAvailable}
            allowAttachments={false}
            placeholder={t("placeholder")}
          />
        </section>

        <aside className="flex w-[380px] shrink-0 flex-col gap-3 overflow-y-auto p-3">
          {session && <SessionStatus session={session} />}
          {session && (
            <PdfPreview
              sessionId={sessionId}
              pageCount={session.pageCount}
              hasOutput={session.score != null}
              refreshKey={refreshKey}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
