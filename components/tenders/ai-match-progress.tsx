"use client";

import { AlertCircle, Check, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/**
 * Staged progress for a match refresh.
 *
 * Deliberately a checklist of named stages rather than a spinner: a refresh
 * takes long enough that "something is happening" is not useful information,
 * and the run lives in Mongo, so this panel resumes at the right stage after a
 * reload instead of restarting at zero.
 */

const STAGES = [
  "building_profile",
  "retrieving",
  "fusing",
  "judging",
  "finalizing",
] as const;

export type MatchStage = (typeof STAGES)[number];

export interface MatchRunState {
  status: "running" | "done" | "failed";
  stage: MatchStage;
  progress: { done: number; total: number };
  scoredCount: number;
  judgedCount: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** How often the panel asks the server where the run got to. */
const POLL_MS = 2500;

export function useMatchRunPolling(active: boolean, onFinished: () => void) {
  const [run, setRun] = useState<MatchRunState | null>(null);
  // Kept in a ref so changing the callback identity never restarts the poll.
  const finished = useRef(onFinished);
  useEffect(() => {
    finished.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch("/api/tenders/ai-matched/status");
        if (!response.ok) return;
        const json = (await response.json()) as { run: MatchRunState | null };
        if (cancelled) return;
        setRun(json.run);
        if (json.run && json.run.status !== "running") {
          clearInterval(timer);
          finished.current();
        }
      } catch {
        // Transient failures are uninteresting — the next tick retries.
      }
    };

    const timer = setInterval(poll, POLL_MS);
    void poll();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active]);

  return run;
}

export function AiMatchProgress({
  run,
  onRetry,
}: {
  run: MatchRunState;
  onRetry: () => void;
}) {
  const t = useTranslations("Tenders.aiMatched");
  const currentIndex = STAGES.indexOf(run.stage);
  const failed = run.status === "failed";

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-5 py-5">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            failed ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary",
          )}
        >
          {failed ? (
            <AlertCircle className="size-4" />
          ) : (
            <Sparkles className="size-4" />
          )}
        </span>
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-semibold text-foreground">
            {failed ? t("states.unavailableTitle") : t("run.title")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {failed
              ? t(`errors.${(run.error ?? "failed") as "failed"}`)
              : t("run.description")}
          </p>
        </div>
      </div>

      {!failed && (
        <ol className="flex flex-col gap-1.5">
          {STAGES.map((stage, index) => {
            const done = index < currentIndex;
            const active = index === currentIndex;
            return (
              <li
                key={stage}
                className={cn(
                  "flex items-center gap-2 text-xs",
                  active
                    ? "font-medium text-foreground"
                    : done
                      ? "text-muted-foreground"
                      : "text-muted-foreground/50",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {done ? (
                    <Check className="size-3.5 text-primary" />
                  ) : active ? (
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-current" />
                  )}
                </span>
                {t(`stages.${stage}`)}
                {active && stage === "judging" && run.progress.total > 0 && (
                  <span className="tabular-nums text-muted-foreground">
                    · {t("run.judged", run.progress)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {failed && (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex w-fit items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          <RefreshCw className="size-3.5" />
          {t("run.retry")}
        </button>
      )}
    </div>
  );
}
