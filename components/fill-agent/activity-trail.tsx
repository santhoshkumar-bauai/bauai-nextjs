"use client";

import { AlertTriangle, Check, ChevronDown, ChevronRight, Loader2, RotateCcw, Sparkles } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import type { WireToolEvent } from "@/lib/ai/agent/wire";
import type { FillWorkflowSnapshot } from "@/lib/ai/fill-agent/workflow-wire";

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

export function WorkflowActivityTrail({
  workflow,
  onRetry,
  retrying = false,
}: {
  workflow: FillWorkflowSnapshot;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const events = workflow.activity.slice(-16);
  const running = !["completed", "needs_review", "awaiting_input"].includes(workflow.status);
  const [open, setOpen] = useState(true);
  if (events.length === 0) return null;
  const latest = events.at(-1)!;
  return (
    <div
      className="my-3 max-w-2xl overflow-hidden rounded-xl border border-border bg-card shadow-sm"
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
          {latest.status === "paused" || latest.status === "failed" ? (
            <AlertTriangle className="size-4 text-amber-500" />
          ) : running && latest.status === "started" ? (
            <Loader2 className="size-4 animate-spin text-primary" />
          ) : (
            <Sparkles className="size-4 text-primary" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-foreground">{latest.message}</span>
          <span className="mt-0.5 flex flex-wrap gap-x-2 text-[10px] text-muted-foreground">
            <span>{workflow.status.replaceAll("_", " ")}</span>
            {latest.pageStart != null && <span>pages {latest.pageStart}–{latest.pageEnd}</span>}
            {latest.model && <span>{latest.model.name} · {latest.model.effort}</span>}
            {workflow.skill && <span>skill {workflow.skill.name} v{workflow.skill.version}</span>}
          </span>
        </span>
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-border px-3 py-2.5">
          <ol className="space-y-2">
            {events.map((event, index) => {
            const isCurrent = running && index === events.length - 1 && event.status === "started";
            return (
              <li key={event.cursor} className="flex gap-2 text-[10px] text-muted-foreground">
                <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
                  {isCurrent ? (
                    <Loader2 className="size-3 animate-spin text-primary" />
                  ) : event.status === "paused" || event.status === "failed" ? (
                    <AlertTriangle className="size-3 text-amber-500" />
                  ) : (
                    <Check className="size-3 text-emerald-600" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={isCurrent ? "font-medium text-foreground" : "text-foreground/85"}>
                    {event.message}
                  </span>
                  <span className="mt-0.5 flex flex-wrap gap-x-2">
                    {event.pageStart != null && <span>pages {event.pageStart}–{event.pageEnd}</span>}
                    {event.model && <span>{event.model.name} · {event.model.effort}</span>}
                    {event.anchorId && <span>anchor {event.anchorId}</span>}
                    {event.patchSummary && (
                      <span>{event.patchSummary.updated} updated · {event.patchSummary.removed} removed</span>
                    )}
                    {event.score != null && <span>score {event.score.toFixed(2)}</span>}
                    {event.elapsedMs != null && <span>{(event.elapsedMs / 1000).toFixed(1)}s</span>}
                    {event.remainingIssues != null && <span>{event.remainingIssues} issues</span>}
                    {event.crop && <span>400 DPI crop · page {event.crop.page}</span>}
                  </span>
                  {event.output && (
                    <span className="mt-1.5 block border-l-2 border-primary/20 pl-2.5">
                      <span className="block font-medium text-foreground/80">{event.output.title}</span>
                      <span className="mt-0.5 block space-y-0.5">
                        {event.output.lines.map((line) => (
                          <span key={line} className="block leading-relaxed">{line}</span>
                        ))}
                      </span>
                    </span>
                  )}
                </span>
              </li>
              );
            })}
          </ol>
          {onRetry && (
            <button
              type="button"
              disabled={retrying}
              onClick={onRetry}
              className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:bg-muted disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {retrying ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
              Retry document workflow
            </button>
          )}
        </div>
      )}
    </div>
  );
}
