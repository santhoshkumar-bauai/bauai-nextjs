"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Lightbulb,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { FitVerdict, TenderRecommendation } from "@/lib/tenders/recommendation";
import { RecList } from "./field";

const VERDICT_VARIANT: Record<FitVerdict, "success" | "info" | "warning" | "danger"> = {
  STRONG_FIT: "success",
  POSSIBLE_FIT: "info",
  WEAK_FIT: "warning",
  NOT_RECOMMENDED: "danger",
};

export interface FitSectionProps {
  rec: TenderRecommendation | null;
  stale: boolean;
  generatedAt: string | null;
  loading: boolean;
  error: string | null;
  onGenerate: () => void;
}

/** Company-fit recommendation section of the AI tab. */
export function FitSection({
  rec,
  stale,
  generatedAt,
  loading,
  error,
  onGenerate,
}: FitSectionProps) {
  const t = useTranslations("Tenders");
  const format = useFormatter();

  return (
    <div className="flex flex-col gap-3">
      {!rec && !loading && !error && (
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <Sparkles className="size-6 text-primary" />
          <p className="max-w-sm text-xs text-muted-foreground">
            {t("recommendation.intro")}
          </p>
          <button
            type="button"
            onClick={onGenerate}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Sparkles className="size-3.5" />
            {t("recommendation.generate")}
          </button>
        </div>
      )}

      {loading && (
        <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
          {t("recommendation.analyzing")}
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-col items-center gap-2 py-8 text-center text-sm">
          <p className="text-muted-foreground">{error}</p>
          <button
            type="button"
            onClick={onGenerate}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
          >
            {t("recommendation.retry")}
          </button>
        </div>
      )}

      {rec && !loading && (
        <div className="flex flex-col gap-4">
          {stale && (
            <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] text-amber-800 ring-1 ring-inset ring-amber-600/20">
              <span>{t("recommendation.staleHint")}</span>
              <button
                type="button"
                onClick={onGenerate}
                className="inline-flex shrink-0 items-center gap-1 font-medium hover:underline"
              >
                <RefreshCw className="size-3" />
                {t("recommendation.regenerate")}
              </button>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <Badge
              variant={VERDICT_VARIANT[rec.verdict]}
              className="px-2.5 py-1 text-xs font-semibold"
            >
              {t(
                `recommendation.verdict.${rec.verdict}` as "recommendation.verdict.STRONG_FIT",
              )}
            </Badge>
            <div className="flex min-w-28 items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t("recommendation.fitScore")}
              </span>
              <Progress value={rec.fitScore / 100} className="w-16" />
              <span className="text-sm font-semibold text-foreground">
                {rec.fitScore}
              </span>
            </div>
          </div>

          {rec.summary && <p className="text-sm text-foreground/90">{rec.summary}</p>}

          {rec.strengths.length > 0 && (
            <RecList
              title={t("recommendation.strengths")}
              items={rec.strengths}
              icon={<CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />}
            />
          )}
          {rec.concerns.length > 0 && (
            <RecList
              title={t("recommendation.concerns")}
              items={rec.concerns}
              icon={<AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />}
            />
          )}
          {rec.suggestedActions.length > 0 && (
            <RecList
              title={t("recommendation.actions")}
              items={rec.suggestedActions}
              icon={<Lightbulb className="mt-0.5 size-3.5 shrink-0 text-sky-600" />}
            />
          )}

          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>{t("recommendation.disclaimer")}</span>
            <span className="flex items-center gap-2">
              {generatedAt && (
                <span>
                  {t("recommendation.generatedAt", {
                    date: format.dateTime(new Date(generatedAt), {
                      dateStyle: "short",
                      timeStyle: "short",
                    }),
                  })}
                </span>
              )}
              {!stale && (
                <button
                  type="button"
                  onClick={onGenerate}
                  className="inline-flex items-center gap-1 hover:text-primary"
                >
                  <RefreshCw className="size-2.5" />
                  {t("recommendation.regenerate")}
                </button>
              )}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
