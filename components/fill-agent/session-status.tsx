"use client";

import { Download, FileOutput } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SerializedFillSession } from "@/lib/ai/fill-agent/store";

/** Server-truth panel: status, score gauge vs target, budget, open items. */
export function SessionStatus({ session }: { session: SerializedFillSession }) {
  const t = useTranslations("FillAgent");

  const statusLabel: Record<SerializedFillSession["status"], string> = {
    ready: t("statusReady"),
    in_progress: t("statusInProgress"),
    filled: t("statusFilled"),
    escalated: t("statusEscalated"),
    failed: t("statusFailed"),
  };
  const statusTone: Record<SerializedFillSession["status"], string> = {
    ready: "bg-muted text-muted-foreground",
    in_progress: "bg-amber-100 text-amber-800",
    filled: "bg-emerald-100 text-emerald-800",
    escalated: "bg-rose-100 text-rose-800",
    failed: "bg-rose-100 text-rose-800",
  };

  return (
    <div className="space-y-3 rounded-xl border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-semibold text-foreground">
          {session.fileName}
        </p>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${statusTone[session.status]}`}
        >
          {statusLabel[session.status]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <dt className="text-muted-foreground">{t("score")}</dt>
        <dd className="text-right font-medium text-foreground">
          {session.score == null
            ? t("noScore")
            : `${session.score.toFixed(2)} / ${session.targetScore.toFixed(2)}`}
        </dd>
        <dt className="text-muted-foreground">{t("iterations")}</dt>
        <dd className="text-right font-medium text-foreground">
          {session.fillIterations} / {session.maxFillIterations}
        </dd>
        {(session.issueCounts.errors > 0 || session.issueCounts.warnings > 0) && (
          <>
            <dt className="text-muted-foreground">{t("status")}</dt>
            <dd className="text-right text-foreground">
              {t("issues", {
                errors: session.issueCounts.errors,
                warnings: session.issueCounts.warnings,
              })}
            </dd>
          </>
        )}
      </dl>

      {session.score != null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${
              session.score >= session.targetScore ? "bg-emerald-500" : "bg-amber-500"
            }`}
            style={{ width: `${Math.round(session.score * 100)}%` }}
          />
        </div>
      )}

      {session.openQuestions.length > 0 && (
        <div>
          <p className="pb-1 text-[11px] font-medium text-foreground">
            {t("openQuestions")}
          </p>
          <ul className="space-y-0.5">
            {session.openQuestions.slice(0, 8).map((question) => (
              <li
                key={question.fieldId}
                className="truncate text-[11px] text-muted-foreground"
              >
                • {question.label}{" "}
                <span className="text-[10px]">
                  (
                  {question.reason === "missing_required"
                    ? t("openQuestionRequired")
                    : t("openQuestionSensitive")}
                  )
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {session.downloadReady && (
        <a
          href={`/api/poc/fill-chat/${session.id}/download`}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:opacity-90"
        >
          <Download className="size-3.5" />
          {t("download")}
        </a>
      )}
      {/* Export the CURRENT state — allowed at any time, even partially
          filled; deterministic replay of the stored fieldmap, no LLM. */}
      {session.fieldCount > 0 && (
        <a
          href={`/api/poc/fill-chat/${session.id}/export`}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
        >
          <FileOutput className="size-3.5" />
          {session.downloadReady ? t("exportCurrent") : t("exportPartial")}
        </a>
      )}
    </div>
  );
}
