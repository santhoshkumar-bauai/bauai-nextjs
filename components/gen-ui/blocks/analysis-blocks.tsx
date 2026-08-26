"use client";

import {
  AlertTriangle,
  CircleDashed,
  CircleHelp,
  CircleSlash,
  Flag,
  Gavel,
  HelpCircle,
  Megaphone,
  MinusCircle,
  Quote as QuoteIcon,
  ShieldCheck,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { BlockPayload } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

import { BlockShell } from "../block-shell";
import { BlockEmpty, ScoreBar, ScoreRing, deadlineTone, TONE_BAR } from "../primitives";

/**
 * The analysis family: the verdict, the requirement checklist and the timeline.
 *
 * All three exist to make a judgement legible at a glance and auditable on a
 * second look — German procurement is adversarial, and "we decided not to bid"
 * has to survive someone asking why six weeks later.
 */

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const DECISION_STYLE = {
  bid: {
    ring: "ring-emerald-600/20",
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    icon: ShieldCheck,
  },
  conditional: {
    ring: "ring-amber-600/25",
    bg: "bg-amber-50",
    text: "text-amber-800",
    icon: AlertTriangle,
  },
  no_bid: {
    ring: "ring-rose-600/20",
    bg: "bg-rose-50",
    text: "text-rose-700",
    icon: CircleSlash,
  },
} as const;

const SEVERITY_BADGE = { high: "danger", medium: "warning", low: "neutral" } as const;

export function BidVerdictBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"bid-verdict">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const format = useFormatter();
  const style = DECISION_STYLE[block.recommendation];
  const DecisionIcon = style.icon;

  return (
    <BlockShell
      kind="bid-verdict"
      blockId={blockId}
      title={t("verdictTitle")}
      caption={block.tenderTitle}
      actions={
        block.stale ? (
          <Badge variant="warning">
            <CircleDashed />
            {t("stale")}
          </Badge>
        ) : null
      }
    >
      <div className="space-y-4">
        <div
          className={cn(
            "flex items-start gap-3 rounded-xl px-4 py-3 ring-1 ring-inset",
            style.bg,
            style.ring,
          )}
        >
          <DecisionIcon className={cn("mt-0.5 size-5 shrink-0", style.text)} />
          <div className="min-w-0">
            <p className={cn("text-sm font-semibold", style.text)}>
              {t(`decision.${block.recommendation}` as "decision.bid")}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-foreground/80">{block.rationale}</p>
          </div>
        </div>

        {/* Five axes as bars rather than one composite number: the composite is
            what people argue about, the breakdown is what they act on. */}
        {block.scores.length > 0 ? (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {block.scores.map((score) => (
              <div key={score.label} className="flex items-center gap-2.5">
                <ScoreRing
                  value={score.value / 100}
                  size={32}
                  label={score.label}
                  tone={score.value >= 66 ? "positive" : score.value >= 33 ? "warning" : "critical"}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] text-muted-foreground">{score.label}</p>
                  <ScoreBar
                    value={score.value / 100}
                    tone={
                      score.value >= 66 ? "positive" : score.value >= 33 ? "warning" : "critical"
                    }
                    className="mt-1"
                  />
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {block.blockers.length > 0 ? (
          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              <MinusCircle className="size-3" />
              {t("blockers")}
            </h4>
            <ul className="space-y-1">
              {block.blockers.map((blocker) => (
                <li
                  key={blocker}
                  className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-900 ring-1 ring-rose-600/15 ring-inset"
                >
                  {blocker}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {block.risks.length > 0 ? (
          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("risks")}
            </h4>
            <ul className="space-y-1.5">
              {block.risks.map((risk) => (
                <li key={risk.text} className="flex items-start gap-2">
                  <Badge variant={SEVERITY_BADGE[risk.severity]} className="mt-0.5">
                    {t(`severity.${risk.severity}` as "severity.high")}
                  </Badge>
                  <span className="min-w-0 flex-1 text-xs text-foreground">
                    {risk.text}
                    {risk.uncited ? (
                      // Surfaced, not hidden: an uncited risk is the model's
                      // inference, and the reader is entitled to weigh it
                      // differently from one anchored in the documents.
                      <span className="ml-1.5 text-[10px] text-muted-foreground">
                        ({t("uncited")})
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {block.openQuestions.length > 0 ? (
          <section>
            <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              <HelpCircle className="size-3" />
              {t("openQuestions")}
            </h4>
            <ul className="space-y-1">
              {block.openQuestions.map((question) => (
                <li key={question} className="text-xs text-muted-foreground">
                  {question}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {block.generatedAt ? (
          <p className="text-[10px] text-muted-foreground">
            {t("generatedAt", {
              date: format.dateTime(new Date(block.generatedAt), { dateStyle: "medium" }),
            })}
          </p>
        ) : null}
      </div>
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Requirements
// ---------------------------------------------------------------------------

const STATUS_STYLE: Record<
  BlockPayload<"requirement-checklist">["items"][number]["status"],
  { icon: LucideIcon; className: string; badge: "success" | "warning" | "danger" | "neutral" }
> = {
  met: { icon: ShieldCheck, className: "text-emerald-600", badge: "success" },
  partial: { icon: AlertTriangle, className: "text-amber-600", badge: "warning" },
  gap: { icon: CircleSlash, className: "text-rose-600", badge: "danger" },
  unknown: { icon: CircleHelp, className: "text-muted-foreground", badge: "neutral" },
};

export function RequirementChecklistBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"requirement-checklist">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");

  const counts = block.items.reduce<Record<string, number>>((acc, item) => {
    acc[item.status] = (acc[item.status] ?? 0) + 1;
    return acc;
  }, {});
  const met = counts.met ?? 0;
  const total = block.items.length;

  return (
    <BlockShell
      kind="requirement-checklist"
      blockId={blockId}
      title={block.title}
      caption={block.caption}
      actions={
        total > 0 ? (
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
            {met}/{total}
          </span>
        ) : null
      }
    >
      {total === 0 ? (
        <BlockEmpty message={t("noRequirements")} />
      ) : (
        <div className="space-y-3">
          {/* A single stacked bar reads faster than four counters and makes the
              proportion of `unknown` — the honest failure mode here — visible. */}
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            {(["met", "partial", "gap", "unknown"] as const).map((status) =>
              counts[status] ? (
                <div
                  key={status}
                  className={cn(
                    "h-full",
                    status === "met" && TONE_BAR.positive,
                    status === "partial" && TONE_BAR.warning,
                    status === "gap" && TONE_BAR.critical,
                    status === "unknown" && TONE_BAR.neutral,
                  )}
                  style={{ width: `${(counts[status] / total) * 100}%` }}
                />
              ) : null,
            )}
          </div>

          <ul className="divide-y divide-border/70">
            {block.items.map((item, index) => {
              const style = STATUS_STYLE[item.status];
              const StatusIcon = style.icon;
              return (
                <li key={`${item.label}-${index}`} className="flex items-start gap-2.5 py-2.5">
                  <StatusIcon className={cn("mt-0.5 size-4 shrink-0", style.className)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className="text-xs font-medium text-foreground">{item.label}</p>
                      {item.mandatory ? (
                        <Badge variant="neutral">
                          <Flag />
                          {t("mandatory")}
                        </Badge>
                      ) : null}
                      <Badge variant={style.badge}>
                        {t(`requirementStatus.${item.status}` as "requirementStatus.met")}
                      </Badge>
                    </div>
                    {item.detail ? (
                      <p className="mt-1 text-xs text-muted-foreground">{item.detail}</p>
                    ) : null}
                    {item.evidence ? (
                      <figure className="mt-1.5 rounded-lg border-l-2 border-primary/40 bg-muted/50 py-1.5 pr-2 pl-2.5">
                        <blockquote className="text-[11px] leading-relaxed text-foreground/80">
                          <QuoteIcon className="mr-1 inline size-2.5 text-primary/60" />
                          {item.evidence.quote}
                        </blockquote>
                        <figcaption className="mt-1 truncate text-[10px] text-muted-foreground">
                          {item.evidence.fileName}
                        </figcaption>
                      </figure>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const TIMELINE_ICON: Record<
  BlockPayload<"deadline-timeline">["items"][number]["kind"],
  LucideIcon
> = {
  publication: Megaphone,
  questions: HelpCircle,
  site_visit: Flag,
  submission: Timer,
  binding: Gavel,
  award: Gavel,
  milestone: Flag,
};

export function DeadlineTimelineBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"deadline-timeline">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const format = useFormatter();

  return (
    <BlockShell
      kind="deadline-timeline"
      blockId={blockId}
      title={block.title}
      caption={block.caption}
    >
      {block.items.length === 0 ? (
        <BlockEmpty message={t("noDates")} />
      ) : (
        <ol className="relative space-y-3.5 pl-5">
          {/* The rail is drawn once behind the whole list rather than as a
              border on each row, so the last item's dot does not dangle off
              the end of a line. */}
          <span
            aria-hidden
            className="absolute top-1.5 bottom-1.5 left-[7px] w-px bg-linear-to-b from-primary/40 via-border to-transparent"
          />
          {block.items.map((item, index) => {
            const Icon = TIMELINE_ICON[item.kind];
            const past = item.daysLeft != null && item.daysLeft < 0;
            const tone = past ? "neutral" : deadlineTone(item.daysLeft);
            return (
              <li key={`${item.label}-${index}`} className="relative">
                <span
                  className={cn(
                    "absolute top-1 -left-5 grid size-3.5 place-items-center rounded-full ring-2 ring-background",
                    past ? "bg-muted-foreground/40" : TONE_BAR[tone],
                  )}
                >
                  <Icon className="size-2 text-white" />
                </span>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <p
                    className={cn(
                      "text-xs font-medium",
                      past ? "text-muted-foreground line-through" : "text-foreground",
                    )}
                  >
                    {item.label}
                  </p>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {item.date
                      ? format.dateTime(new Date(item.date), { dateStyle: "medium" })
                      : "—"}
                  </span>
                  {item.daysLeft != null && !past ? (
                    <Badge variant={tone === "critical" ? "danger" : tone === "warning" ? "warning" : "info"}>
                      {t("daysLeft", { days: item.daysLeft })}
                    </Badge>
                  ) : null}
                </div>
                {item.detail ? (
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{item.detail}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
    </BlockShell>
  );
}
