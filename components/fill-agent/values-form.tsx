"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, SkipForward } from "lucide-react";
import { useTranslations } from "next-intl";

import type { OpenQuestion } from "@/lib/ai/fill-agent/fieldmap";
import type { DecisionGroup } from "@/lib/ai/fill-agent/workflow-wire";

/**
 * The generative gap-filling form: rendered from the session's server-held
 * open questions whenever the agent's analysis left fields without values.
 * The user fills what they know (or nothing) — submit lands the values via
 * the same ratcheted code path as the chat tool, skip just dismisses. Only
 * required fields ever block a fill run.
 */
export function ValuesForm({
  sessionId,
  questions,
  onApplied,
  onSkipped,
  decisions = [],
  resumeWorkflow = false,
}: {
  sessionId: string;
  questions: OpenQuestion[];
  /** Called after a successful submit with the count of provided values. */
  onApplied: (count: number) => void;
  onSkipped: () => void;
  decisions?: DecisionGroup[];
  resumeWorkflow?: boolean;
}) {
  const t = useTranslations("FillAgent");
  const editable = useMemo(
    () => questions.filter((question) => question.reason !== "sensitive"),
    [questions],
  );
  const sensitive = useMemo(
    () => questions.filter((question) => question.reason === "sensitive"),
    [questions],
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [decisionValues, setDecisionValues] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  if (editable.length === 0 && sensitive.length === 0 && decisions.length === 0) return null;

  const provided = Object.entries(values).filter(([, value]) => value.trim() !== "");
  const requiredValueIds = new Set(editable.filter((question) => question.reason === "missing_required").map((question) => question.fieldId));
  const allRequiredValuesProvided = [...requiredValueIds].every((fieldId) => (values[fieldId] ?? "").trim() !== "");
  const allDecisionsProvided = decisions.every((decision) => Boolean(decisionValues[decision.id]));
  const canResume = !resumeWorkflow || (allRequiredValuesProvided && allDecisionsProvided);
  const completedRequiredValues = [...requiredValueIds].filter(
    (fieldId) => (values[fieldId] ?? "").trim() !== "",
  ).length;
  const completedDecisions = decisions.filter((decision) => Boolean(decisionValues[decision.id])).length;
  const requiredCompleted = completedRequiredValues + completedDecisions;
  const requiredTotal = requiredValueIds.size + decisions.length;

  const submit = async () => {
    const selectedDecisions = Object.entries(decisionValues);
    if (provided.length === 0 && selectedDecisions.length === 0) return;
    setSubmitting(true);
    setError(false);
    try {
      const response = await fetch(
        resumeWorkflow
          ? `/api/poc/fill-chat/${sessionId}/workflow`
          : `/api/poc/fill-chat/${sessionId}/values`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(resumeWorkflow ? { action: "resume" } : {}),
          values: provided.map(([fieldId, value]) => ({ fieldId, value: value.trim() })),
          ...(resumeWorkflow
            ? { decisions: selectedDecisions.map(([groupId, fieldId]) => ({ groupId, fieldId })) }
            : {}),
        }),
      });
      if (!response.ok) throw new Error("values_failed");
      setValues({});
      setDecisionValues({});
      onApplied(provided.length + selectedDecisions.length);
    } catch {
      setError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const placeholderFor = (question: OpenQuestion): string => {
    switch (question.valueType) {
      case "eur":
      case "eur_sym":
        return "2450000";
      case "date":
        return "17.07.2026";
      case "integer":
      case "number":
        return "42";
      case "percent":
        return "12,5";
      case "phone":
        return "030 1234567";
      default:
        return "";
    }
  };

  return (
    <div className="flex max-h-[min(52svh,38rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-primary/30 bg-primary/5 shadow-sm">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-primary/15 bg-background/90 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-foreground">{t("formTitle")}</p>
          <p className="text-[11px] text-muted-foreground">{t("formHint")}</p>
        </div>
        {requiredTotal > 0 && (
          <span
            className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary"
            aria-live="polite"
          >
            {t("formProgress", { completed: requiredCompleted, total: requiredTotal })}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-3 py-3 [scrollbar-gutter:stable]">
        {editable.length > 0 && (
          <div className="space-y-2">
            {editable.map((question) => (
              <label key={question.fieldId} className="block">
                <span className="mb-0.5 flex items-baseline gap-1 text-[11px] font-medium text-foreground">
                  <span className="truncate">{question.label}</span>
                  {question.reason === "missing_required" && (
                    <span className="shrink-0 text-[10px] text-rose-600">
                      {t("formRequired")}
                    </span>
                  )}
                </span>
                <input
                  type="text"
                  value={values[question.fieldId] ?? ""}
                  placeholder={placeholderFor(question)}
                  onChange={(event) =>
                    setValues((prev) => ({
                      ...prev,
                      [question.fieldId]: event.target.value,
                    }))
                  }
                  className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </label>
            ))}
          </div>
        )}

        {decisions.length > 0 && (
          <fieldset className="space-y-3">
            <legend className="mb-2 text-[11px] font-semibold text-foreground">
              {t("formLegalTitle")}
            </legend>
            {decisions.map((decision) => (
              <div key={decision.id} className="rounded-lg border border-border/80 bg-background/70 p-2.5">
                <p className="text-[11px] leading-relaxed text-foreground">{decision.label}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {decision.options.map((option) => (
                    <label key={option.fieldId} className="cursor-pointer">
                      <input
                        type="radio"
                        name={decision.id}
                        value={option.fieldId}
                        checked={decisionValues[decision.id] === option.fieldId}
                        onChange={() => setDecisionValues((previous) => ({ ...previous, [decision.id]: option.fieldId }))}
                        className="peer sr-only"
                      />
                      <span className="block rounded-lg border border-border bg-background px-2.5 py-1 text-[11px] text-foreground peer-checked:border-primary peer-checked:bg-primary/10 peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2">
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </fieldset>
        )}

        {sensitive.length > 0 && (
          <p className="text-[10px] text-muted-foreground">
            {t("formSensitiveNote", {
              fields: sensitive.map((question) => question.label).join(", "),
            })}
          </p>
        )}

        {error && <p className="text-[11px] text-rose-600">{t("formError")}</p>}
      </div>

      {/* Icon + label always live in their own elements: a bare text node
          beside a conditionally swapped icon is exactly what browser
          translators (Chrome auto-translate wraps loose text in <font>)
          corrupt, crashing React with insertBefore NotFoundError. */}
      <div className="flex shrink-0 items-center gap-2 border-t border-primary/15 bg-background/95 px-3 py-2.5">
        <button
          type="button"
          disabled={submitting || !canResume || (provided.length === 0 && Object.keys(decisionValues).length === 0)}
          onClick={() => void submit()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <span className="flex size-3.5 items-center justify-center">
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
          </span>
          <span>{t("formSubmit", { count: provided.length + Object.keys(decisionValues).length })}</span>
        </button>
        {!resumeWorkflow && <button
          type="button"
          disabled={submitting}
          onClick={onSkipped}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50"
        >
          <SkipForward className="size-3.5" />
          <span>{t("formSkip")}</span>
        </button>}
      </div>
    </div>
  );
}
