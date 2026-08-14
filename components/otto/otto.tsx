"use client";

import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AgentActionsProvider,
  useAgentDispatch,
} from "@/components/agent/agent-actions";
import type { OnboardingAgentStatus } from "@/models/account-profile";
import type { MilestoneId } from "@/lib/onboarding/milestones";
import { trackOnboardingEvent } from "@/lib/onboarding/telemetry";
import { OttoActions } from "./otto-actions";
import { OttoPanel } from "./otto-panel";
import { OttoSelectorCheck } from "./otto-selector-check";
import { useOttoChat } from "./use-otto-chat";

/**
 * Otto's mount point. Rendered inside DashboardShell, which is the single
 * shell every authenticated page goes through — so Otto is absent from the
 * marketing and auth pages, and from the full-bleed document editor, without
 * needing a route allowlist.
 */

export interface OttoProps {
  /** Server-rendered from AccountProfile.onboardingAgent. */
  initialStatus: OnboardingAgentStatus;
  initialPlanned: MilestoneId[];
  initialCompleted: MilestoneId[];
}

export function Otto(props: OttoProps) {
  return (
    <AgentActionsProvider
      onFailure={(failure) =>
        trackOnboardingEvent({
          name: "tool_call_failed",
          tool: failure.action,
          reason:
            failure.reason === "unknown_action"
              ? "unknown_action"
              : `${failure.reason}: ${"detail" in failure ? failure.detail : ""}`,
        })
      }
    >
      <OttoRuntime {...props} />
    </AgentActionsProvider>
  );
}

function OttoRuntime({ initialStatus, initialPlanned, initialCompleted }: OttoProps) {
  const t = useTranslations("Otto");
  const { dispatch, snapshotReadables } = useAgentDispatch();

  const [status, setStatus] = useState<OnboardingAgentStatus>(initialStatus);
  // Auto-opens for someone who has never seen it; everyone else opts in.
  const [open, setOpen] = useState(initialStatus === "not_started");
  const [seedRequest, setSeedRequest] = useState<MilestoneId | null>(null);
  const [guidanceOnly, setGuidanceOnly] = useState(false);

  const chat = useOttoChat({
    onUiCalls: dispatch,
    readReadables: snapshotReadables,
    enabled: open,
  });

  const startedRef = useRef(false);
  const completedRef = useRef(false);

  /** Network only — never touches React state, so it is safe from an effect. */
  const persistStatus = useCallback(
    (next: Extract<OnboardingAgentStatus, "in_progress" | "dismissed">) => {
      void fetch("/api/otto/state", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      }).catch(() => {
        // A failed write means the tour may reappear next session, which is a
        // better outcome than blocking the user's exit on a network call.
      });
    },
    [],
  );

  // First open is what "started" means — the server has no other signal. The
  // ref guard, rather than a status write, is what keeps this firing once.
  useEffect(() => {
    if (!open || initialStatus !== "not_started" || startedRef.current) return;
    startedRef.current = true;
    trackOnboardingEvent({ name: "onboarding_started" });
    persistStatus("in_progress");
  }, [open, initialStatus, persistStatus]);

  const dismiss = useCallback(() => {
    trackOnboardingEvent({ name: "onboarding_dismissed" });
    setOpen(false);
    setStatus("dismissed");
    // Persisted server-side, so it stays dismissed on the next device too.
    persistStatus("dismissed");
  }, [persistStatus]);

  const planned = chat.summary?.plannedMilestoneIds.length
    ? chat.summary.plannedMilestoneIds
    : initialPlanned;
  const completed = chat.summary?.completedMilestoneIds.length
    ? chat.summary.completedMilestoneIds
    : initialCompleted;

  // Completion is DERIVED from graph state rather than stored, so there is no
  // second copy to drift. The effect exists only to emit the event once.
  const completed_ = chat.agentState?.status === "completed";
  useEffect(() => {
    if (!completed_ || completedRef.current) return;
    completedRef.current = true;
    trackOnboardingEvent({ name: "onboarding_completed" });
  }, [completed_]);

  const confirmSeed = useCallback(
    async (milestoneId: MilestoneId) => {
      setSeedRequest(null);
      // The only empty state in this product that is a genuine dead end is the
      // tender feed before matching has ever run — and the fix for it is to
      // run the real thing, not to write fake tenders into a live account.
      if (milestoneId !== "build_ai_matches") {
        trackOnboardingEvent({
          name: "tool_call_failed",
          tool: "seedDemoData",
          milestoneId,
          reason: "no_seeder_for_milestone",
        });
        return;
      }
      try {
        await fetch("/api/tenders/ai-matched/refresh", { method: "POST" });
      } catch {
        trackOnboardingEvent({
          name: "tool_call_failed",
          tool: "seedDemoData",
          milestoneId,
          reason: "refresh_request_failed",
        });
      }
    },
    [],
  );

  if (status === "dismissed" && !open) {
    // Dismissal must stick: no pill, no nagging. Otto stays reachable from
    // the AI Tutorial nav item, which is a deliberate, user-initiated route.
    return null;
  }

  const doneCount = completed.filter((id) => planned.includes(id)).length;

  return (
    <>
      <OttoActions
        onSeedRequest={setSeedRequest}
        onGuidanceOnly={() => setGuidanceOnly(true)}
      />
      <OttoSelectorCheck />

      <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
        {open ? (
          <OttoPanel
            messages={chat.messages}
            streamingText={chat.streamingText}
            agentState={chat.agentState}
            plannedFallback={planned}
            completedFallback={completed}
            sending={chat.sending}
            error={chat.error}
            seedRequest={seedRequest}
            guidanceOnly={guidanceOnly}
            onSend={chat.send}
            onConfirmSeed={confirmSeed}
            onDismissSeed={() => setSeedRequest(null)}
            onClose={() => setOpen(false)}
            onSkipTour={dismiss}
          />
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex items-center gap-2 rounded-full border border-border bg-background px-3.5 py-2 text-xs font-medium text-foreground shadow-lg transition-colors hover:border-primary/40 hover:text-primary"
          >
            <Sparkles className="size-3.5 text-primary" />
            {planned.length > 0
              ? t("launcher.resume", { done: doneCount, total: planned.length })
              : t("launcher.open")}
          </button>
        )}
      </div>
    </>
  );
}
