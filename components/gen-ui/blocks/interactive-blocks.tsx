"use client";

import { ArrowRight, SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { BlockPayload } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

import { BlockShell } from "../block-shell";
import { useIrisActions } from "../iris-context";

/**
 * The two blocks that take input rather than give output.
 *
 * This is the half of generative UI that gets skipped. Rendering a chart
 * instead of a paragraph is a presentation upgrade; rendering a CONTROL means
 * the model can hand the conversation back in a form the user can answer in
 * one click, without composing a sentence that repeats four ids back at it.
 *
 * Both send a real user message. Nothing is hidden: the transcript shows
 * exactly what was asked, so the history stays honest and the next turn's
 * context is the same whether the user clicked or typed.
 */

// ---------------------------------------------------------------------------
// Choice
// ---------------------------------------------------------------------------

export function ChoicePromptBlock({ block }: { block: BlockPayload<"choice-prompt"> }) {
  const t = useTranslations("GenUi.blocks");
  const { sendPrompt, isStreaming } = useIrisActions();
  const [chosen, setChosen] = useState<string | null>(null);

  return (
    <BlockShell kind="choice-prompt" title={block.question} caption={block.caption}>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {block.options.map((option) => (
          <button
            key={option.id}
            type="button"
            // Locked after the first click, not just disabled during the
            // stream: the answer is already in the transcript and a second
            // click would ask the same question twice.
            disabled={isStreaming || chosen !== null}
            onClick={() => {
              setChosen(option.id);
              sendPrompt(option.prompt);
            }}
            className={cn(
              "group flex items-start gap-2 rounded-xl border px-3 py-2.5 text-left transition-all",
              chosen === option.id
                ? "border-primary bg-primary/8"
                : "border-border bg-card hover:border-primary/40 hover:bg-muted/40",
              (isStreaming || chosen !== null) && chosen !== option.id && "opacity-50",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-foreground">{option.label}</p>
              {option.description ? (
                <p className="mt-0.5 text-[11px] text-muted-foreground">{option.description}</p>
              ) : null}
            </div>
            <ArrowRight
              className={cn(
                "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
                chosen === option.id ? "text-primary" : "group-hover:translate-x-0.5",
              )}
            />
          </button>
        ))}
      </div>
      {block.allowFreeText && chosen === null ? (
        <p className="mt-2.5 text-[10px] text-muted-foreground">{t("orTypeInstead")}</p>
      ) : null}
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const DEADLINE_PRESETS = [7, 14, 30, 90] as const;

export function FilterRefineBlock({ block }: { block: BlockPayload<"filter-refine"> }) {
  const t = useTranslations("GenUi.blocks");
  const { sendPrompt, isStreaming } = useIrisActions();

  const [picked, setPicked] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      block.facets.map((facet) => [
        facet.key,
        facet.values.filter((value) => value.selected).map((value) => value.value),
      ]),
    ),
  );
  const [deadlineDays, setDeadlineDays] = useState<number | null>(block.deadlineDays ?? null);
  const [applied, setApplied] = useState(false);

  const toggle = (facetKey: string, value: string, multi: boolean) =>
    setPicked((current) => {
      const selected = current[facetKey] ?? [];
      if (selected.includes(value)) {
        return { ...current, [facetKey]: selected.filter((entry) => entry !== value) };
      }
      return { ...current, [facetKey]: multi ? [...selected, value] : [value] };
    });

  const total =
    Object.values(picked).reduce((sum, values) => sum + values.length, 0) +
    (deadlineDays ? 1 : 0);

  /**
   * The selection is turned into a sentence rather than posted as a filter
   * object. The agent already owns the feed tool and its arguments; sending it
   * prose keeps ONE path into the ranking, and keeps the transcript readable
   * six turns later.
   */
  const apply = () => {
    const parts = block.facets
      .map((facet) => {
        const values = picked[facet.key] ?? [];
        if (values.length === 0) return null;
        const labels = values.map(
          (value) => facet.values.find((entry) => entry.value === value)?.label ?? value,
        );
        return `${facet.label}: ${labels.join(", ")}`;
      })
      .filter((part): part is string => part !== null);

    if (deadlineDays) parts.push(t("deadlineWithin", { days: deadlineDays }));
    setApplied(true);
    sendPrompt(t("refinePrompt", { filters: parts.join("; ") }));
  };

  return (
    <BlockShell kind="filter-refine" title={block.title} caption={block.caption}>
      <div className="space-y-3.5">
        {block.facets.map((facet) => (
          <fieldset key={facet.key}>
            <legend className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {facet.label}
            </legend>
            <div className="flex flex-wrap gap-1.5">
              {facet.values.map((value) => {
                const isPicked = (picked[facet.key] ?? []).includes(value.value);
                return (
                  <button
                    key={value.value}
                    type="button"
                    aria-pressed={isPicked}
                    disabled={isStreaming || applied}
                    onClick={() => toggle(facet.key, value.value, facet.multi ?? false)}
                    className={cn(
                      "flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors disabled:opacity-60",
                      isPicked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-card text-foreground hover:border-primary/40",
                    )}
                  >
                    <span className="truncate">{value.label}</span>
                    {value.count != null ? (
                      <span
                        className={cn(
                          "tabular-nums",
                          isPicked ? "text-primary-foreground/70" : "text-muted-foreground",
                        )}
                      >
                        {value.count}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ))}

        <fieldset>
          <legend className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("deadlineWindow")}
          </legend>
          <div className="flex flex-wrap gap-1.5">
            {DEADLINE_PRESETS.map((days) => (
              <button
                key={days}
                type="button"
                aria-pressed={deadlineDays === days}
                disabled={isStreaming || applied}
                onClick={() => setDeadlineDays(deadlineDays === days ? null : days)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] tabular-nums transition-colors disabled:opacity-60",
                  deadlineDays === days
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-card text-foreground hover:border-primary/40",
                )}
              >
                {t("withinDays", { days })}
              </button>
            ))}
          </div>
        </fieldset>

        <div className="flex items-center gap-2 border-t border-border/70 pt-3">
          <p className="mr-auto text-[11px] text-muted-foreground">
            {total === 0 ? t("noFiltersPicked") : t("filtersPicked", { count: total })}
          </p>
          <Button size="sm" disabled={total === 0 || isStreaming || applied} onClick={apply}>
            <SlidersHorizontal />
            {block.submitLabel ?? t("applyFilters")}
          </Button>
        </div>
      </div>
    </BlockShell>
  );
}
