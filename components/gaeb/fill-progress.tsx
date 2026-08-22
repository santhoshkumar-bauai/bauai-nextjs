"use client";

import { Check, CircleDashed, Loader2, Sparkles, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { GaebApiFillRun } from "./api-types";

/**
 * Staged, resumable fill progress — real counts from the persisted run
 * document, never a synthetic percentage. Renders the start affordance when
 * no run exists yet.
 */

type StageState = "done" | "active" | "pending";

function Stage({ state, label, detail }: { state: StageState; label: string; detail?: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[12px]">
      {state === "done" ? (
        <Check className="size-3.5 text-primary" />
      ) : state === "active" ? (
        <Loader2 className="size-3.5 animate-spin text-primary" />
      ) : (
        <CircleDashed className="size-3.5 text-muted-foreground/60" />
      )}
      <span className={cn(state === "pending" ? "text-muted-foreground/70" : "text-foreground")}>
        {label}
        {detail ? <span className="ml-1 tabular-nums text-muted-foreground">{detail}</span> : null}
      </span>
    </span>
  );
}

export function FillProgress({
  run,
  canFill,
  aiAvailable,
  busy,
  actionError,
  onStart,
  onRetryFailed,
  onCancel,
}: {
  run: GaebApiFillRun | null;
  canFill: boolean;
  aiAvailable: boolean;
  busy: string;
  actionError: string | null;
  onStart: () => void;
  onRetryFailed: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("Gaeb.fill");

  if (!run) {
    if (!canFill) return null;
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-primary/[0.04] px-4 py-2.5">
        <Sparkles className="size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">{t("startHint")}</p>
        {actionError && <p className="text-[12px] text-red-600">{t("error", { message: actionError })}</p>}
        <Button
          size="sm"
          disabled={!aiAvailable || busy === "start"}
          title={aiAvailable ? undefined : t("unavailable")}
          onClick={onStart}
        >
          {busy === "start" ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {t("start")}
        </Button>
      </div>
    );
  }

  const gaeb = run.gaeb ?? null;
  const total = gaeb?.sourceItemCount ?? 0;
  const active = run.status === "queued" || run.status === "analyzing";

  if (active) {
    const stageOrder = ["discovering", "grounding", "validating"];
    const stageIndex = stageOrder.indexOf(run.stage);
    const classifyDone = gaeb ? gaeb.classifiedCount + gaeb.pricedCount + gaeb.failedCount + gaeb.skippedCount : 0;
    const webState: StageState =
      stageIndex > 1 ? "done" : run.stage === "grounding" ? "active" : "pending";
    return (
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-border bg-primary/[0.04] px-4 py-2.5">
        <Stage state={stageIndex > 0 ? "done" : "active"} label={t("stageParse")} />
        <Stage
          state={stageIndex > 0 ? (stageIndex > 1 ? "done" : "active") : "pending"}
          label={t("stageClassify")}
          detail={total > 0 && stageIndex >= 0 ? t("counted", { done: Math.min(classifyDone, total), total }) : undefined}
        />
        <Stage
          state={webState}
          label={t("stageWeb")}
          detail={
            gaeb && gaeb.webLookupsTotal > 0
              ? t("counted", { done: gaeb.webLookupsDone, total: gaeb.webLookupsTotal })
              : undefined
          }
        />
        <Stage
          state={run.stage === "validating" ? "active" : "pending"}
          label={t("stagePrice")}
          detail={
            total > 0 && run.stage === "validating"
              ? t("counted", { done: (gaeb?.pricedCount ?? 0) + (gaeb?.failedCount ?? 0), total })
              : undefined
          }
        />
        <span className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy === "cancel"} onClick={onCancel}>
            {t("cancel")}
          </Button>
        </span>
      </div>
    );
  }

  if (run.status === "generating") {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-primary/[0.04] px-4 py-2.5 text-[12px] text-foreground">
        <Loader2 className="size-4 animate-spin text-primary" />
        {t("generating")}
      </div>
    );
  }

  if (run.status === "completed" && run.generatedDocumentId) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-emerald-50/70 px-4 py-2.5 text-[12px]">
        <Check className="size-4 text-emerald-600" />
        <span>{t("completed")}</span>
        <Link
          href={`/document-filler/${run.generatedDocumentId}`}
          className="font-medium text-primary underline-offset-2 hover:underline"
        >
          {t("openGenerated")}
        </Link>
      </div>
    );
  }

  if (run.status === "review" && gaeb) {
    if (gaeb.failedCount === 0 && !actionError) return null;
    return (
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-amber-50/70 px-4 py-2 text-[12px]">
        {gaeb.failedCount > 0 && (
          <>
            <TriangleAlert className="size-4 text-amber-600" />
            <span>{t("failedCount", { count: gaeb.failedCount })}</span>
            <Button variant="outline" size="sm" disabled={busy === "retry"} onClick={onRetryFailed}>
              {busy === "retry" ? <Loader2 className="animate-spin" /> : null}
              {t("retryFailed")}
            </Button>
          </>
        )}
        {actionError && <span className="text-red-600">{t("error", { message: actionError })}</span>}
      </div>
    );
  }

  if (run.status === "failed") {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-red-50/70 px-4 py-2 text-[12px] text-red-700">
        <TriangleAlert className="size-4" />
        {t("error", { message: run.error ?? "unknown" })}
        {canFill && (
          <Button variant="outline" size="sm" disabled={busy === "start"} onClick={onStart}>
            {t("start")}
          </Button>
        )}
      </div>
    );
  }

  if (run.status === "cancelled") {
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-4 py-2 text-[12px] text-muted-foreground">
        {t("cancelled")}
        {canFill && (
          <Button variant="outline" size="sm" disabled={busy === "start"} onClick={onStart}>
            {t("start")}
          </Button>
        )}
      </div>
    );
  }

  return null;
}
