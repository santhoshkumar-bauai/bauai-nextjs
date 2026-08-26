"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { ChatInput } from "@/components/chat/chat-input";
import { MessageList } from "@/components/chat/message-list";
import { useClaraChat } from "@/components/chat/use-clara-chat";
import { workflowOwnsDocument } from "@/lib/ai/fill-agent/workflow-wire";
import { LiveActivityTrail, MessageSteps, WorkflowActivityTrail } from "./activity-trail";
import { PdfPreview } from "./pdf-preview";
import { SessionStatus } from "./session-status";
import { useFillSession } from "./use-fill-session";
import { ValuesForm } from "./values-form";
import { useAiErrorMessage } from "../chat/use-ai-error-message";

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
  backHref = "/poc/fill-chat",
  backLabelKey = "back",
}: {
  sessionId: string;
  aiAvailable: boolean;
  /** Where "back" leads — the POC list or the document-filler chooser. */
  backHref?: string;
  /** FillAgent message key for the back link, matching backHref's target. */
  backLabelKey?: "back" | "chooserBack";
}) {
  const t = useTranslations("FillAgent");
  const aiErrorMessage = useAiErrorMessage();
  const locale = useLocale() as "en" | "de";
  const chat = useClaraChat(`/api/poc/fill-chat/${sessionId}/chat`, { locale });
  const { session, refresh, renderVersion } = useFillSession(sessionId);
  const [retryingWorkflow, setRetryingWorkflow] = useState(false);

  const retryWorkflow = async () => {
    setRetryingWorkflow(true);
    try {
      await fetch(`/api/poc/fill-chat/${sessionId}/workflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retry" }),
      });
      await refresh();
    } finally {
      setRetryingWorkflow(false);
    }
  };

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

  // While the workflow owns the document it is the only engine allowed to
  // touch the field map and the sandbox (the chat's pipeline tools are
  // server-refused), so the UI must not nudge the chat agent into "continue"
  // turns that would only produce refusals and a contradictory narration.
  const workflowOwns = workflowOwnsDocument(session?.workflow);

  // Fresh session + empty conversation → the agent starts by itself: opening
  // the chat IS the request to analyze. Deferred a tick (repo convention) so
  // the kickoff send never runs inside the effect body.
  //
  // A run is also (re)started from a STRANDED claim: the route marks the
  // workflow as owning the document before the background continuation runs,
  // so a server restart in that window would otherwise leave a session that
  // owns the document, never produces activity, and blocks the chat's own
  // pipeline forever. No activity a minute after the claim means nothing is
  // running — a live run persists its first event within seconds.
  const autoStartedRef = useRef(false);
  const STRANDED_CLAIM_MS = 60_000;
  useEffect(() => {
    if (autoStartedRef.current || !aiAvailable) return;
    if (chat.loading || chat.sending) return;
    if (!session || session.workflow.activityCursor > 0) return;
    const stranded =
      workflowOwnsDocument(session.workflow) &&
      Date.now() - new Date(session.updatedAt).getTime() > STRANDED_CLAIM_MS;
    if (session.workflow.status !== "queued" && !stranded) return;
    autoStartedRef.current = true;
    const timer = setTimeout(() => {
      void fetch(`/api/poc/fill-chat/${sessionId}/workflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      }).then(() => refresh());
    }, 0);
    return () => clearTimeout(timer);
  }, [
    aiAvailable,
    chat,
    chat.loading,
    chat.sending,
    session,
    sessionId,
    refresh,
  ]);

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

  // The workflow parks on `awaiting_input` until something resumes it. The
  // values form is one way; answering the same questions in CHAT (the agent's
  // set_field_values) is the other, and without this the run would sit paused
  // forever once the form has nothing left to show. Keyed on the pause's
  // activity cursor so a later pause with new questions re-arms it, and the
  // route ignores a resume for a run that is not parked.
  const resumedPauseRef = useRef<number | null>(null);
  useEffect(() => {
    if (!session || chat.sending) return;
    if (session.workflow.status !== "awaiting_input") return;
    const blocked =
      session.openQuestions.some((question) => question.reason === "missing_required") ||
      session.workflow.decisions.some((decision) => decision.required && !decision.selection);
    if (blocked) return;
    const pauseKey = session.workflow.activityCursor;
    if (resumedPauseRef.current === pauseKey) return;
    resumedPauseRef.current = pauseKey;
    const timer = setTimeout(() => {
      void fetch(`/api/poc/fill-chat/${sessionId}/workflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", values: [], decisions: [] }),
      }).then(() => refresh());
    }, 0);
    return () => clearTimeout(timer);
  }, [session, chat.sending, sessionId, refresh]);
  const formKey = [
    ...openQuestions.map((question) => question.fieldId),
    ...(session?.workflow.decisions ?? [])
      .filter((decision) => decision.required && !decision.selection)
      .map((decision) => decision.id),
  ].join("|");
  const showForm =
    aiAvailable &&
    !chat.sending &&
    session != null &&
    session.status !== "filled" &&
    (openQuestions.some((question) => question.reason !== "sensitive") ||
      session.workflow.decisions.some((decision) => decision.required && !decision.selection)) &&
    dismissedFormKey !== formKey;
  const pendingDecisions = session?.workflow.decisions.filter(
    (decision) => decision.required && !decision.selection,
  ) ?? [];
  const currentBatch = session?.workflow.batches.find(
    (batch) => batch.id === session.workflow.currentBatchId,
  ) ?? null;

  const lastAssistant = [...chat.messages]
    .reverse()
    .find((message) => message.role === "assistant");

  return (
    <div className="fixed inset-0 flex min-h-0 flex-col overflow-clip bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <Link
          href={backHref}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          <span>{t(backLabelKey)}</span>
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
                  autoScroll="pinned"
                />
                {!chat.sending && lastAssistant && (
                  <MessageSteps toolEvents={lastAssistant.toolEvents} />
                )}
              </>
            )}
            {chat.sending && (
              <LiveActivityTrail steps={trail} activeTool={chat.activeTool} />
            )}
            {session && (
              <WorkflowActivityTrail
                workflow={session.workflow}
                retrying={retryingWorkflow}
                // Also offered mid-run: the chat's own pipeline is refused
                // while the workflow owns the document, so restarting the run
                // is the user's way out of one that has gone wrong.
                onRetry={
                  session.status === "failed" || workflowOwns
                    ? () => void retryWorkflow()
                    : undefined
                }
              />
            )}
            {chat.error && (
              <p className="pt-2 text-center text-xs text-rose-600">
                {aiErrorMessage(chat.error)}
              </p>
            )}
          </div>

          {showForm && (
            <div className="min-h-0 shrink-0 border-t border-border px-4 py-3">
              <ValuesForm
                sessionId={sessionId}
                questions={openQuestions}
                decisions={pendingDecisions}
                resumeWorkflow={session.workflow.status === "awaiting_input"}
                onApplied={(count) => {
                  setDismissedFormKey(null);
                  void refresh();
                  // A "continue" turn only makes sense when the chat agent is
                  // the engine. During a run the workflow picks the values up
                  // itself; nudging the agent here just races it.
                  if (!workflowOwns) {
                    chat.send(t("formContinueMessage", { count }));
                  }
                }}
                onSkipped={() => {
                  setDismissedFormKey(formKey);
                  if (!workflowOwns) chat.send(t("formSkipMessage"));
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
              hasOutput={session.score != null || currentBatch?.outputFile != null}
              renderVersion={renderVersion}
              pageRange={currentBatch}
              repairBatchReady={currentBatch?.outputFile != null}
              activeCrop={session.workflow.activeCrop}
              workflowStatus={session.workflow.status}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
