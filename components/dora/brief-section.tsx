"use client";

import {
  AlertTriangle,
  Check,
  CircleDashed,
  ClipboardCopy,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { CitationChips } from "@/components/chat/citation-chip";
import type { WireBriefRunState, WireBriefStatus, WireDocumentBrief } from "@/lib/ai/dora/wire";
import { cn } from "@/lib/utils";

/**
 * The Document Brief: staged progress while generating (resumable across
 * reloads — the run doc, not the request, is the source of truth), then the
 * analysis cards. Dora tells the user what the file is and what to do with it.
 */
export function BriefSection({
  status,
  error,
  running,
  aiAvailable,
  onGenerate,
}: {
  status: WireBriefStatus | null;
  error: string | null;
  running: boolean;
  aiAvailable: boolean;
  onGenerate: (refresh: boolean) => void;
}) {
  const t = useTranslations("Dora");

  if (!aiAvailable) {
    return <Note>{t("noProvider")}</Note>;
  }
  if (!status) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border px-3 py-2.5 text-[11px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {t("loading")}
      </div>
    );
  }

  const failed = status.run?.status === "failed" && !status.brief;

  return (
    <div className="flex flex-col gap-2">
      {running && status.run && <StageList run={status.run} />}
      {(failed || error) && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5">
          <span className="text-[11px] text-rose-700">
            {error === "not_ready"
              ? t("notReady")
              : status.run?.error === "rate_limited"
                ? t("rateLimited")
                : t("failed")}
          </span>
          <button
            type="button"
            onClick={() => onGenerate(false)}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-rose-200 px-2 py-1 text-[11px] font-medium text-rose-700 hover:bg-rose-100"
          >
            <RefreshCw className="size-3" />
            {t("retry")}
          </button>
        </div>
      )}
      {status.brief && (
        <BriefCards brief={status.brief} running={running} onRefresh={() => onGenerate(true)} />
      )}
    </div>
  );
}

function StageList({ run }: { run: WireBriefRunState }) {
  const t = useTranslations("Dora.stages");
  // A non-refresh run never enters saving_editor; hide the row unless it is
  // the live stage so skipped work is not shown as done.
  const stages: Array<WireBriefRunState["stage"]> =
    run.stage === "saving_editor"
      ? ["saving_editor", "extracting", "grounding", "analyzing", "translating", "saving"]
      : ["extracting", "grounding", "analyzing", "translating", "saving"];
  const currentIndex = stages.indexOf(run.stage);

  return (
    <div className="rounded-xl border border-border px-3 py-2.5">
      <p className="mb-2 text-[11px] font-semibold text-foreground">
        {t("title")}
      </p>
      <ol className="flex flex-col gap-1.5">
        {stages.map((stage, index) => (
          <li key={stage} className="flex items-center gap-2 text-[11px]">
            {index < currentIndex ? (
              <Check className="size-3.5 text-emerald-600" />
            ) : index === currentIndex ? (
              <Loader2 className="size-3.5 animate-spin text-primary" />
            ) : (
              <CircleDashed className="size-3.5 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                index === currentIndex
                  ? "font-medium text-foreground"
                  : index < currentIndex
                    ? "text-muted-foreground"
                    : "text-muted-foreground/60",
              )}
            >
              {t(stage)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function BriefCards({
  brief,
  running,
  onRefresh,
}: {
  brief: WireDocumentBrief;
  running: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations("Dora");

  return (
    <div className="flex flex-col gap-2">
      {brief.stale && !running && (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
          <span className="text-[11px] text-amber-800">{t("stale")}</span>
          <button
            type="button"
            onClick={onRefresh}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-amber-300 px-2 py-1 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
          >
            <RefreshCw className="size-3" />
            {t("reanalyze")}
          </button>
        </div>
      )}
      {brief.textStatus !== "ready" && (
        <Note tone="warn">
          {brief.textNote === "no_text_layer"
            ? t("noTextLayer")
            : t("textUnavailable")}
        </Note>
      )}
      {brief.textNote === "first_sheet_only" && (
        <Note tone="warn">{t("firstSheetOnly")}</Note>
      )}

      <Card title={t("cards.about")}>
        <p className="text-[11px] font-medium text-foreground">
          {brief.documentType}
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">{brief.purpose}</p>
        <p className="mt-1.5 text-[11px] leading-relaxed text-foreground/90">
          {brief.summary}
        </p>
      </Card>

      {brief.requiredActions.length > 0 && (
        <Card title={t("cards.actions")}>
          <ol className="flex flex-col gap-2">
            {brief.requiredActions.map((action, index) => (
              <li key={index} className="flex gap-2">
                <span className="mt-px grid size-4 shrink-0 place-items-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-foreground">
                    {action.step}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {action.detail}
                  </p>
                  <CitationChips citations={action.citations} />
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {brief.suggestedValues.length > 0 && (
        <Card title={t("cards.values")}>
          <ul className="flex flex-col gap-1.5">
            {brief.suggestedValues.map((entry, index) => (
              <SuggestedValue key={index} entry={entry} />
            ))}
          </ul>
        </Card>
      )}

      {brief.deadlines.length > 0 && (
        <Card title={t("cards.deadlines")}>
          <ul className="flex flex-col gap-1.5">
            {brief.deadlines.map((deadline, index) => (
              <li key={index} className="text-[11px]">
                <span className="font-medium text-foreground">
                  {deadline.label}
                </span>
                {deadline.date && (
                  <span className="ml-1.5 text-muted-foreground">
                    {deadline.date}
                  </span>
                )}
                <CitationChips citations={deadline.citations} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {brief.keyRequirements.length > 0 && (
        <Card title={t("cards.requirements")}>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {brief.keyRequirements.map((requirement, index) => (
              <li key={index} className="text-[11px] text-foreground/90">
                {requirement.text}
                <CitationChips citations={requirement.citations} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {brief.risks.length > 0 && (
        <Card title={t("cards.risks")}>
          <ul className="flex flex-col gap-1.5">
            {brief.risks.map((risk, index) => (
              <li key={index} className="flex items-start gap-1.5 text-[11px]">
                <AlertTriangle
                  className={cn(
                    "mt-px size-3 shrink-0",
                    risk.severity === "high"
                      ? "text-rose-600"
                      : risk.severity === "medium"
                        ? "text-amber-600"
                        : "text-muted-foreground",
                  )}
                />
                <div className="min-w-0">
                  <span className="text-foreground/90">{risk.text}</span>
                  <CitationChips citations={risk.citations} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {brief.missingInfo.length > 0 && (
        <Card title={t("cards.missing")}>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {brief.missingInfo.map((item, index) => (
              <li key={index} className="text-[11px] text-muted-foreground">
                {item}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function SuggestedValue({
  entry,
}: {
  entry: WireDocumentBrief["suggestedValues"][number];
}) {
  const t = useTranslations("Dora");
  const [copied, setCopied] = useState(false);

  return (
    <li className="rounded-lg border border-border/70 px-2 py-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-[11px] font-medium text-foreground">
          {entry.field}
        </span>
        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
          {t(`source.${entry.source}`)}
        </span>
      </div>
      <div className="mt-0.5 flex items-start justify-between gap-2">
        <span className="min-w-0 text-[11px] text-foreground/90">{entry.value}</span>
        <button
          type="button"
          aria-label={t("copyValue")}
          title={t("copyValue")}
          onClick={() => {
            void navigator.clipboard.writeText(entry.value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1_500);
            });
          }}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {copied ? (
            <Check className="size-3 text-emerald-600" />
          ) : (
            <ClipboardCopy className="size-3" />
          )}
        </button>
      </div>
      <CitationChips citations={entry.citations} />
    </li>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-border px-3 py-2.5">
      <h3 className="mb-1.5 text-[11px] font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Note({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "warn";
}) {
  return (
    <p
      className={cn(
        "rounded-xl border px-3 py-2 text-[11px]",
        tone === "warn"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-border text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}
