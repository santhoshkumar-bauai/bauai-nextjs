"use client";

import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import type { WireToolEvent } from "@/lib/ai/agent/wire";
import type {
  FillActivityEvent,
  FillWorkflowSnapshot,
} from "@/lib/ai/fill-agent/workflow-wire";

/**
 * Claude-style "what is the agent doing" surfaces:
 *  - LiveActivityTrail: the running turn's tool steps, checked off as they
 *    complete, spinner on the current one (fed by activeTool transitions).
 *  - MessageSteps: a collapsed per-message summary rendered from the
 *    persisted toolEvents once the turn is done.
 * Labels come from the shared Chat.tool catalog; unknown tools degrade to
 * their raw name rather than crashing on a missing key.
 */

const KNOWN_TOOL_LABELS = new Set([
  "analyze_pdf",
  "propose_fieldmap",
  "set_field_values",
  "fill_and_validate",
  "critique_fill",
  "repair_fieldmap",
  "run_python",
  "render_preview",
  "get_session_status",
  "get_company_profile",
  "search_company_data",
]);

function useToolLabel() {
  const t = useTranslations("Chat");
  return (name: string): string =>
    KNOWN_TOOL_LABELS.has(name) ? t(`tool.${name}`) : name;
}

export function LiveActivityTrail({
  steps,
  activeTool,
}: {
  /** Completed + current tool names of the running turn, in order. */
  steps: string[];
  activeTool: string | null;
}) {
  const label = useToolLabel();
  if (steps.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 rounded-xl border border-border bg-background px-3 py-2">
      {steps.map((step, index) => {
        const isCurrent = index === steps.length - 1 && step === activeTool;
        return (
          <div
            key={`${step}-${index}`}
            className="flex items-center gap-2 text-[11px] text-muted-foreground"
          >
            {isCurrent ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-primary" />
            ) : (
              <Check className="size-3 shrink-0 text-emerald-600" />
            )}
            <span className={isCurrent ? "text-foreground" : ""}>{label(step)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function MessageSteps({ toolEvents }: { toolEvents: WireToolEvent[] }) {
  const t = useTranslations("FillAgent");
  const label = useToolLabel();
  const [open, setOpen] = useState(false);
  if (toolEvents.length === 0) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
      >
        <span className="flex size-3 items-center justify-center">
          {open ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
        </span>
        <span>{t("steps", { count: toolEvents.length })}</span>
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 border-l border-border pl-3">
          {toolEvents.map((event, index) => (
            <li
              key={`${event.name}-${index}`}
              className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground"
            >
              <span>{label(event.name)}</span>
              <span className="tabular-nums">
                {(event.durationMs / 1000).toFixed(1)}s
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The workflow's progress lives in the DOCUMENT panel, not in the conversation.
 * Two trails in the chat column — the agent's tool steps and the run's steps —
 * were two answers to "what is happening", stacked above two answers to "how do
 * I reply" (the values form and the chat input). Splitting them by subject
 * gives one place to look and one place to act: left is the conversation, right
 * is the document. `WorkflowStatusLine` is the one thread back to the chat.
 */

function statusIcon(status: FillActivityEvent["status"], running: boolean, size = "size-3") {
  if (status === "paused" || status === "failed") {
    return <AlertTriangle className={`${size} text-amber-500`} />;
  }
  if (running && status === "started") {
    return <Loader2 className={`${size} animate-spin text-primary`} />;
  }
  return <Check className={`${size} text-emerald-600`} />;
}

type TrailRow =
  | { kind: "step"; event: FillActivityEvent }
  | {
      kind: "batch";
      batchId: string;
      events: FillActivityEvent[];
      pageStart: number | null;
      pageEnd: number | null;
    };

/**
 * One row per repair BATCH instead of seven per attempt.
 *
 * The repair loop emits crop → review → patch → refill → rescore for every
 * attempt, and the run-wide budget allows forty of them. Rendered flat that is
 * a couple of hundred near-identical rows, each repeating the same page range —
 * which is what read as clutter. The batch is the unit a person actually wants
 * to see; the attempts inside it are detail.
 */
export function groupTrail(events: FillActivityEvent[]): TrailRow[] {
  const rows: TrailRow[] = [];
  for (const event of events) {
    if (!event.batchId) {
      rows.push({ kind: "step", event });
      continue;
    }
    const last = rows.at(-1);
    if (last?.kind === "batch" && last.batchId === event.batchId) {
      last.events.push(event);
      continue;
    }
    rows.push({
      kind: "batch",
      batchId: event.batchId,
      events: [event],
      pageStart: event.pageStart,
      pageEnd: event.pageEnd,
    });
  }
  return rows;
}

/** Attempts, score movement and remaining issues — the batch in one line. */
export function summariseBatch(events: FillActivityEvent[]): {
  attempts: number;
  scores: number[];
  remainingIssues: number | null;
  needsReview: boolean;
} {
  const scores = events
    .map((event) => event.score)
    .filter((score): score is number => score != null);
  const remaining = events
    .map((event) => event.remainingIssues)
    .filter((count): count is number => count != null);
  return {
    attempts: events.filter(
      (event) => event.action === "repair_region" && event.status === "completed",
    ).length,
    scores,
    remainingIssues: remaining.at(-1) ?? null,
    needsReview: events.some((event) => event.status === "paused" || event.status === "failed"),
  };
}

function EventFacts({ event }: { event: FillActivityEvent }) {
  return (
    <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
      {event.model && <span>{event.model.name} · {event.model.effort}</span>}
      {event.anchorId && <span className="truncate">anchor {event.anchorId}</span>}
      {event.patchSummary && (
        <span>{event.patchSummary.updated} updated · {event.patchSummary.removed} removed</span>
      )}
      {event.score != null && <span>score {event.score.toFixed(2)}</span>}
      {event.remainingIssues != null && <span>{event.remainingIssues} issues</span>}
      {event.elapsedMs != null && <span>{(event.elapsedMs / 1000).toFixed(1)}s</span>}
    </span>
  );
}

/** Compact one-liner for the chat column: what the run is doing, right now. */
export function WorkflowStatusLine({ workflow }: { workflow: FillWorkflowSnapshot }) {
  const t = useTranslations("FillAgent");
  const latest = workflow.activity.at(-1);
  const running = !["completed", "needs_review", "awaiting_input"].includes(workflow.status);
  if (!latest) return null;
  const open = workflow.activity
    .map((event) => event.remainingIssues)
    .filter((count): count is number => count != null)
    .at(-1);
  return (
    <div
      className="sticky top-0 z-10 -mx-4 -mt-3 mb-3 flex items-center gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">
        {statusIcon(latest.status, running, "size-3.5")}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{latest.message}</span>
      {open != null && (
        <span className="shrink-0 text-[10px] text-muted-foreground">
          {t("issuesOpen", { count: open })}
        </span>
      )}
    </div>
  );
}

export function WorkflowActivityTrail({
  workflow,
  onRetry,
  retrying = false,
}: {
  workflow: FillWorkflowSnapshot;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const t = useTranslations("FillAgent");
  const events = workflow.activity.slice(-60);
  const running = !["completed", "needs_review", "awaiting_input"].includes(workflow.status);
  // Open while there is something to watch; a finished run is a summary until
  // asked otherwise.
  const [open, setOpen] = useState(running);
  const [openBatch, setOpenBatch] = useState<string | null>(null);
  if (events.length === 0) return null;
  const rows = groupTrail(events);
  const latest = events.at(-1)!;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          {running ? (
            <Loader2 className="size-3.5 animate-spin text-primary" />
          ) : (
            <Sparkles className="size-3.5 text-primary" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium text-foreground">{t("runProgress")}</span>
          <span className="block truncate text-[10px] text-muted-foreground">
            {workflow.status.replaceAll("_", " ")}
            {workflow.skill && ` · ${workflow.skill.name} v${workflow.skill.version}`}
          </span>
        </span>
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>

      {open && (
        <div className="max-h-[42svh] overflow-y-auto border-t border-border px-3 py-2">
          <ol className="space-y-1.5">
            {rows.map((row) => {
              if (row.kind === "step") {
                const isCurrent = running && row.event.cursor === latest.cursor
                  && row.event.status === "started";
                return (
                  <li key={row.event.cursor} className="flex gap-2 text-[10px]">
                    <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
                      {statusIcon(row.event.status, isCurrent)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={isCurrent ? "font-medium text-foreground" : "text-foreground/85"}>
                        {row.event.message}
                      </span>
                      <EventFacts event={row.event} />
                      {row.event.output && (
                        <span className="mt-1 block border-l-2 border-primary/20 pl-2 text-[10px] text-muted-foreground">
                          {row.event.output.lines.map((line) => (
                            <span key={line} className="block leading-relaxed">{line}</span>
                          ))}
                        </span>
                      )}
                    </span>
                  </li>
                );
              }

              const summary = summariseBatch(row.events);
              const isOpen = openBatch === row.batchId;
              const isCurrent = running && row.events.some((event) => event.cursor === latest.cursor);
              return (
                <li key={row.batchId} className="text-[10px]">
                  <button
                    type="button"
                    onClick={() => setOpenBatch(isOpen ? null : row.batchId)}
                    className="flex w-full gap-2 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
                      {statusIcon(summary.needsReview ? "paused" : "completed", isCurrent)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-foreground/85">
                        {t("repairBatch", {
                          pageStart: row.pageStart ?? 0,
                          pageEnd: row.pageEnd ?? 0,
                        })}
                      </span>
                      <span className="mt-0.5 flex flex-wrap gap-x-2 text-muted-foreground">
                        <span>{t("repairAttempts", { count: summary.attempts })}</span>
                        {summary.scores.length > 0 && (
                          <span>
                            score {summary.scores[0].toFixed(2)}
                            {summary.scores.length > 1 && ` → ${summary.scores.at(-1)!.toFixed(2)}`}
                          </span>
                        )}
                        {summary.remainingIssues != null && (
                          <span>{t("issuesOpen", { count: summary.remainingIssues })}</span>
                        )}
                      </span>
                    </span>
                    <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center text-muted-foreground">
                      {isOpen ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                    </span>
                  </button>
                  {isOpen && (
                    <ol className="mt-1 space-y-1 border-l border-border pl-3">
                      {row.events.map((event) => (
                        <li key={event.cursor} className="text-muted-foreground">
                          <span className="block text-foreground/75">{event.message}</span>
                          <EventFacts event={event} />
                        </li>
                      ))}
                    </ol>
                  )}
                </li>
              );
            })}
          </ol>
          {onRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={onRetry}
              className="mt-2.5 flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[10px] font-medium text-foreground hover:bg-muted disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
              {t("retryWorkflow")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
