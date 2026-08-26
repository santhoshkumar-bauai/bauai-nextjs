"use client";

import { getToolName, isToolUIPart, type ToolUIPart } from "ai";
import { AlertCircle, Check, ChevronRight, Wrench } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { isIrisToolName, type IrisTools, type IrisUIMessage } from "@/lib/ai/iris/wire";
import { cn } from "@/lib/utils";

/**
 * The tool timeline for one assistant turn.
 *
 * Generative UI has a specific failure mode: the blocks are so much more
 * finished-looking than a chat bubble that the reader stops asking where the
 * numbers came from. The rail is the counterweight — collapsed it is one line
 * ("four views assembled"), expanded it names every tool that ran and what it
 * was asked for.
 *
 * It reads the AI SDK's tool parts rather than a side channel, which is why
 * the server bothers to emit `tool-input-available` / `tool-output-available`
 * at all: the blocks would render perfectly well without them.
 */

type IrisToolPart = ToolUIPart<IrisTools>;

function toolParts(message: IrisUIMessage): IrisToolPart[] {
  return message.parts.filter((part): part is IrisToolPart => isToolUIPart(part));
}

/** The one or two arguments worth showing. Ids are noise; a query is not. */
function summarizeInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  const interesting = ["query", "title", "question", "scope", "codes", "statuses", "limit"];
  const parts: string[] = [];
  for (const key of interesting) {
    const value = record[key];
    if (value == null || value === "") continue;
    parts.push(Array.isArray(value) ? value.join(", ") : String(value));
    if (parts.length === 2) break;
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function ToolRow({ part }: { part: IrisToolPart }) {
  const t = useTranslations("GenUi");
  const name = getToolName(part);
  const label = isIrisToolName(name) ? t(`tools.${name}` as "tools.show_opportunity_feed") : name;
  const running = part.state === "input-streaming" || part.state === "input-available";
  const failed = part.state === "output-error";
  const summary = "input" in part ? summarizeInput(part.input) : null;

  return (
    <li className="flex items-center gap-2 py-1">
      <span
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full",
          failed
            ? "bg-rose-100 text-rose-600"
            : running
              ? "bg-primary/15 text-primary"
              : "bg-emerald-100 text-emerald-600",
        )}
      >
        {failed ? (
          <AlertCircle className="size-2.5" />
        ) : running ? (
          <span className="iris-breathe size-1.5 rounded-full bg-primary" />
        ) : (
          <Check className="size-2.5" />
        )}
      </span>
      <span className="shrink-0 text-[11px] font-medium text-foreground">{label}</span>
      {summary ? (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">{summary}</span>
      ) : null}
    </li>
  );
}

export function ActivityRail({ message }: { message: IrisUIMessage }) {
  const t = useTranslations("GenUi.activity");
  const [open, setOpen] = useState(false);
  const parts = toolParts(message);

  if (parts.length === 0) return null;

  const running = parts.filter(
    (part) => part.state === "input-streaming" || part.state === "input-available",
  ).length;

  return (
    <div className="rounded-xl border border-border bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <Wrench className="size-3 shrink-0 text-muted-foreground" />
        <span className="text-[11px] font-medium text-muted-foreground">
          {running > 0 ? t("running", { count: running }) : t("done", { count: parts.length })}
        </span>
        <ChevronRight
          className={cn(
            "ml-auto size-3 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>
      {open ? (
        <ul className="border-t border-border/70 px-3 py-1.5">
          {parts.map((part) => (
            <ToolRow key={part.toolCallId} part={part} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}
