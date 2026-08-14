"use client";

import { Check, Circle, Loader2, Send, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState, type FormEvent } from "react";

import type { WireChatMessage } from "@/lib/ai/agent/wire";
import {
  PROFILE_CHOICES,
  type OttoWireState,
  type ProfileQuestionId,
} from "@/lib/ai/otto/wire";
import { MILESTONES, type MilestoneId } from "@/lib/onboarding/milestones";

/**
 * Otto's panel: a conversation, a live checklist driven by graph state, and
 * choice buttons for the profile questions.
 *
 * The checklist is the point. Rendering the agent's own state as it changes is
 * what separates this from a chatbot in the corner — the user can see the plan
 * it chose and watch it tick off against verified data.
 */

export interface OttoPanelProps {
  messages: WireChatMessage[];
  streamingText: string;
  agentState: OttoWireState | null;
  plannedFallback: MilestoneId[];
  completedFallback: MilestoneId[];
  sending: boolean;
  error: string | null;
  seedRequest: MilestoneId | null;
  guidanceOnly: boolean;
  onSend: (message: string) => void;
  onConfirmSeed: (milestoneId: MilestoneId) => void;
  onDismissSeed: () => void;
  onClose: () => void;
  onSkipTour: () => void;
}

export function OttoPanel(props: OttoPanelProps) {
  const t = useTranslations("Otto");
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const planned = props.agentState?.plannedMilestones.length
    ? props.agentState.plannedMilestones
    : props.plannedFallback;
  const completed = props.agentState?.completedMilestoneIds.length
    ? props.agentState.completedMilestoneIds
    : props.completedFallback;
  const current = props.agentState?.currentMilestoneId ?? null;
  const pending = props.agentState?.pendingQuestion ?? null;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [props.messages.length, props.streamingText]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.trim() || props.sending) return;
    props.onSend(draft);
    setDraft("");
  };

  return (
    <div className="flex h-[min(34rem,calc(100vh-8rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-foreground">{t("panel.title")}</p>
          {planned.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {t("panel.progress", {
                done: completed.filter((id) => planned.includes(id)).length,
                total: planned.length,
              })}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label={t("launcher.close")}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </header>

      {planned.length > 0 && (
        <ol className="max-h-40 shrink-0 overflow-y-auto border-b border-border px-4 py-3">
          {planned.map((id) => {
            const done = completed.includes(id);
            return (
              <li key={id} className="flex items-start gap-2 py-1 text-xs">
                {done ? (
                  <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
                ) : (
                  <Circle
                    className={`mt-0.5 size-3.5 shrink-0 ${
                      id === current ? "text-primary" : "text-muted-foreground/50"
                    }`}
                  />
                )}
                <span
                  className={
                    done
                      ? "text-muted-foreground line-through"
                      : id === current
                        ? "font-medium text-foreground"
                        : "text-muted-foreground"
                  }
                >
                  {t(`milestones.${MILESTONES[id].labelKey}`)}
                </span>
              </li>
            );
          })}
        </ol>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {props.messages.length === 0 && !props.sending && (
          <p className="text-xs text-muted-foreground">{t("panel.intro")}</p>
        )}

        {props.messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === "user"
                ? "ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-xs text-primary-foreground"
                : "max-w-[90%] text-xs leading-relaxed text-foreground"
            }
          >
            {message.content}
          </div>
        ))}

        {props.streamingText && (
          <div className="max-w-[90%] text-xs leading-relaxed text-foreground">
            {props.streamingText}
          </div>
        )}

        {props.sending && !props.streamingText && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            {t("panel.thinking")}
          </p>
        )}

        {props.guidanceOnly && (
          <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t("panel.mobileNotice")}
          </p>
        )}

        {props.seedRequest && (
          <div className="rounded-md border border-border px-3 py-2">
            <p className="text-xs text-foreground">
              {t(`milestones.${MILESTONES[props.seedRequest].bodyKey}`)}
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => props.onConfirmSeed(props.seedRequest!)}
                className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                {t("panel.showMe")}
              </button>
              <button
                type="button"
                onClick={props.onDismissSeed}
                className="rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted"
              >
                {t("panel.skipStep")}
              </button>
            </div>
          </div>
        )}

        {props.error && (
          <p className="text-xs text-rose-600" role="alert">
            {t(`errors.${props.error === "rate_limited" ? "rate_limited" : "failed"}`)}
          </p>
        )}
      </div>

      {/*
        Profile questions render as buttons rather than making someone type.
        The chosen id is sent as an ordinary message, which is how the graph
        resumes without a separate resume transport.
      */}
      {pending && !props.sending && (
        <div className="shrink-0 border-t border-border px-4 py-3">
          {/*
            No question label here: Otto asks it in the message above, and
            printing it again just renders the same sentence twice.
          */}
          <div className="flex flex-wrap gap-1.5">
            {PROFILE_CHOICES[pending as ProfileQuestionId].map((choice) => (
              <button
                key={choice}
                type="button"
                onClick={() => props.onSend(choice)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                {t(`profile.${pending}.choices.${choice}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={submit} className="flex shrink-0 gap-2 border-t border-border p-3">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t("panel.placeholder")}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary/50"
        />
        <button
          type="submit"
          disabled={props.sending || !draft.trim()}
          aria-label={t("panel.send")}
          className="rounded-md bg-primary px-2.5 text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <Send className="size-3.5" />
        </button>
      </form>

      <button
        type="button"
        onClick={props.onSkipTour}
        className="shrink-0 border-t border-border px-4 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {t("panel.skip")}
      </button>
    </div>
  );
}
