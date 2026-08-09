"use client";

import { AlertTriangle, ShieldAlert } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { WireVerdict } from "@/lib/ai/agent/wire";
import { CitationChips } from "./citation-chip";

const RECOMMENDATION_VARIANT = {
  bid: "success",
  conditional: "warning",
  no_bid: "danger",
} as const;

const SEVERITY_VARIANT = {
  low: "neutral",
  medium: "warning",
  high: "danger",
} as const;

const SCORE_KEYS = [
  "eligibilityFit",
  "strategicFit",
  "capacityFit",
  "contractRisk",
  "deadlineFeasibility",
] as const;

/** Rich bid/no-bid verdict card rendered inside the Clara chat. */
export function VerdictCard({ verdict }: { verdict: WireVerdict }) {
  const t = useTranslations("Chat.verdict");
  const format = useFormatter();

  return (
    <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <Badge
          variant={RECOMMENDATION_VARIANT[verdict.recommendation]}
          className="px-2.5 py-1 text-xs font-semibold"
        >
          {t(`recommendation.${verdict.recommendation}` as "recommendation.bid")}
        </Badge>
        {verdict.stale && <Badge variant="warning">{t("stale")}</Badge>}
      </div>

      <p className="text-xs leading-relaxed text-foreground/90">{verdict.rationale}</p>

      <div className="grid gap-1.5">
        {SCORE_KEYS.map((key) => (
          <div key={key} className="flex items-center gap-2">
            <span className="w-36 shrink-0 text-[10px] text-muted-foreground">
              {t(`scores.${key}` as "scores.eligibilityFit")}
            </span>
            <Progress value={verdict.scoreBreakdown[key]} className="flex-1" />
            <span className="w-8 shrink-0 text-right text-[10px] font-semibold text-foreground">
              {Math.round(verdict.scoreBreakdown[key] * 100)}%
            </span>
          </div>
        ))}
      </div>

      {verdict.risks.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700">
            <AlertTriangle className="size-3" />
            {t("risks")}
          </span>
          {verdict.risks.map((risk, index) => (
            <div key={index} className="flex flex-col gap-1">
              <div className="flex items-start gap-1.5">
                <Badge variant={SEVERITY_VARIANT[risk.severity]} className="mt-0.5 shrink-0">
                  {t(`severity.${risk.severity}` as "severity.high")}
                </Badge>
                <span className="text-[11px] text-foreground/90">{risk.text}</span>
              </div>
              <CitationChips citations={risk.citations} />
            </div>
          ))}
        </div>
      )}

      {verdict.blockingRequirements.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="flex items-center gap-1 text-[11px] font-semibold text-rose-700">
            <ShieldAlert className="size-3" />
            {t("blocking")}
          </span>
          {verdict.blockingRequirements.map((requirement, index) => (
            <div key={index} className="flex flex-col gap-1">
              <span className="text-[11px] text-foreground/90">• {requirement.text}</span>
              <CitationChips citations={requirement.citations} />
            </div>
          ))}
        </div>
      )}

      {verdict.unresolvedQuestions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-muted-foreground">
            {t("unresolved")}
          </span>
          {verdict.unresolvedQuestions.map((question, index) => (
            <span key={index} className="text-[11px] text-muted-foreground">
              • {question}
            </span>
          ))}
        </div>
      )}

      <span className="text-[10px] text-muted-foreground">
        {t("generatedAt", {
          date: format.dateTime(new Date(verdict.generatedAt), {
            dateStyle: "short",
            timeStyle: "short",
          }),
        })}
      </span>
    </div>
  );
}
