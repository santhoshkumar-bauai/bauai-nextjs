"use client";

import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import type { WireToolEvent } from "@/lib/ai/agent/wire";

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
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        {t("steps", { count: toolEvents.length })}
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
