"use client";

import { Check, FileSearch, Languages, PenLine, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import type { ReportStage } from "@/lib/ai/report/service";
import { cn } from "@/lib/utils";

/**
 * The generation experience. A full report is two model calls over a very
 * large context, so this shows the run's REAL stages (streamed over SSE) as an
 * ordered checklist rather than an indeterminate spinner — the reader can see
 * what is happening and roughly how far along it is.
 */

const STEPS: Array<{ stage: ReportStage; icon: typeof FileSearch }> = [
  { stage: "gathering", icon: FileSearch },
  { stage: "analyzing", icon: PenLine },
  { stage: "translating", icon: Languages },
  { stage: "saving", icon: Save },
];

/**
 * Seconds since this component mounted. No reset needed: the parent only
 * mounts the progress card while a run is in flight, so each run starts from
 * a fresh zero (and setState stays out of the effect body).
 */
function useElapsed(active: boolean) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const id = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [active]);
  return active ? seconds : 0;
}

export function ReportProgress({ stage }: { stage: ReportStage | null }) {
  const t = useTranslations("Tenders.report");
  const elapsed = useElapsed(stage !== null);

  const activeIndex = Math.max(
    0,
    STEPS.findIndex((step) => step.stage === stage),
  );
  const completion = ((activeIndex + 0.5) / STEPS.length) * 100;
  const minutes = Math.floor(elapsed / 60);
  const clock = `${minutes}:${String(elapsed % 60).padStart(2, "0")}`;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-border bg-card px-6 py-8 shadow-xs">
      {/* Slow aurora wash — motion without a spinner, disabled for users who
          ask for reduced motion. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-70 motion-safe:animate-[report-aurora_9s_ease-in-out_infinite] bg-[radial-gradient(60%_120%_at_20%_0%,rgba(63,84,239,0.10),transparent_60%),radial-gradient(50%_100%_at_85%_20%,rgba(154,44,231,0.09),transparent_55%)]"
      />

      <div className="relative flex flex-col gap-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-semibold text-foreground">
              {t("generating")}
            </p>
            <p className="max-w-md text-xs text-muted-foreground">
              {t("takesAWhile")}
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-border bg-background/70 px-2.5 py-1 font-mono text-[11px] tabular-nums text-muted-foreground">
            {clock}
          </span>
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-700 ease-out"
            style={{ width: `${completion}%` }}
          />
        </div>

        <ol className="flex flex-col gap-3">
          {STEPS.map((step, index) => {
            const done = index < activeIndex;
            const active = index === activeIndex;
            const Icon = step.icon;
            return (
              <li
                key={step.stage}
                className={cn(
                  "flex items-center gap-3 text-sm transition-opacity duration-300",
                  !done && !active && "opacity-40",
                )}
              >
                <span
                  className={cn(
                    "grid size-7 shrink-0 place-items-center rounded-full border transition-colors",
                    done && "border-emerald-500/30 bg-emerald-50 text-emerald-600",
                    active && "border-primary/40 bg-primary/10 text-primary",
                    !done && !active && "border-border bg-muted text-muted-foreground",
                  )}
                >
                  {done ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Icon
                      className={cn(
                        "size-3.5",
                        active && "motion-safe:animate-pulse",
                      )}
                    />
                  )}
                </span>
                <span
                  className={cn(
                    "text-xs",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {t(`stages.${step.stage}` as "stages.analyzing")}
                </span>
                {active && (
                  <span className="ml-auto flex gap-1" aria-hidden>
                    {[0, 1, 2].map((dot) => (
                      <span
                        key={dot}
                        className="size-1 rounded-full bg-primary/60 motion-safe:animate-bounce"
                        style={{ animationDelay: `${dot * 140}ms` }}
                      />
                    ))}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

/** Skeleton of the finished document, shown beneath the progress card. */
export function ReportSkeleton() {
  return (
    <div
      aria-hidden
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card px-6 py-6"
    >
      <div className="h-3 w-24 rounded bg-muted motion-safe:animate-pulse" />
      <div className="h-6 w-2/3 rounded bg-muted motion-safe:animate-pulse" />
      <div className="flex flex-col gap-2 pt-2">
        {[100, 96, 88, 92, 60].map((width, index) => (
          <div
            key={index}
            className="h-3 rounded bg-muted/70 motion-safe:animate-pulse"
            style={{ width: `${width}%`, animationDelay: `${index * 90}ms` }}
          />
        ))}
      </div>
      <div className="grid gap-2 pt-3 sm:grid-cols-2">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="h-14 rounded-lg bg-muted/60 motion-safe:animate-pulse"
            style={{ animationDelay: `${index * 120}ms` }}
          />
        ))}
      </div>
    </div>
  );
}
