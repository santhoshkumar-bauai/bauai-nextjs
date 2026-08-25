"use client";

import { useMemo, useState } from "react";
import { Check, Loader2, SkipForward } from "lucide-react";
import { useTranslations } from "next-intl";

import type { OpenQuestion } from "@/lib/ai/fill-agent/fieldmap";

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
}: {
  sessionId: string;
  questions: OpenQuestion[];
  /** Called after a successful submit with the count of provided values. */
  onApplied: (count: number) => void;
  onSkipped: () => void;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(false);

  if (editable.length === 0 && sensitive.length === 0) return null;

  const provided = Object.entries(values).filter(([, value]) => value.trim() !== "");

  const submit = async () => {
    if (provided.length === 0) return;
    setSubmitting(true);
    setError(false);
    try {
      const response = await fetch(`/api/poc/fill-chat/${sessionId}/values`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          values: provided.map(([fieldId, value]) => ({ fieldId, value: value.trim() })),
        }),
      });
      if (!response.ok) throw new Error("values_failed");
      setValues({});
      onApplied(provided.length);
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
    <div className="space-y-3 rounded-xl border border-primary/30 bg-primary/5 p-3">
      <div>
        <p className="text-xs font-semibold text-foreground">{t("formTitle")}</p>
        <p className="text-[11px] text-muted-foreground">{t("formHint")}</p>
      </div>

      {editable.length > 0 && (
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
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
                className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-primary focus:outline-none"
              />
            </label>
          ))}
        </div>
      )}

      {sensitive.length > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {t("formSensitiveNote", {
            fields: sensitive.map((question) => question.label).join(", "),
          })}
        </p>
      )}

      {error && <p className="text-[11px] text-rose-600">{t("formError")}</p>}

      {/* Icon + label always live in their own elements: a bare text node
          beside a conditionally swapped icon is exactly what browser
          translators (Chrome auto-translate wraps loose text in <font>)
          corrupt, crashing React with insertBefore NotFoundError. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={submitting || provided.length === 0}
          onClick={() => void submit()}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          <span className="flex size-3.5 items-center justify-center">
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
          </span>
          <span>{t("formSubmit", { count: provided.length })}</span>
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={onSkipped}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
        >
          <SkipForward className="size-3.5" />
          <span>{t("formSkip")}</span>
        </button>
      </div>
    </div>
  );
}
