"use client";

import {
  ArrowRightCircle,
  Briefcase,
  Building2,
  CalendarClock,
  Loader2,
  MapPin,
  RotateCcw,
  Route,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import { deadlineDaysLeft, deadlineUrgency } from "@/lib/tenders/deadline";
import type { SerializedTender } from "@/lib/tenders/serialize";
import { cn } from "@/lib/utils";

import { AiMatchReason } from "./ai-match-reason";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  CLOSING_SOON: "bg-amber-50 text-amber-700 ring-amber-600/20",
  UPCOMING: "bg-sky-50 text-sky-700 ring-sky-600/20",
};

/**
 * Countdown pill styling per urgency band. Same bands (and therefore the same
 * day count) as the detail dialog's `DeadlineChip` — the card must never
 * disagree with the tender it opens.
 */
const COUNTDOWN_STYLES = {
  critical: "bg-red-50 text-red-600 ring-red-600/20",
  soon: "bg-amber-50 text-amber-700 ring-amber-600/20",
} as const;

/** Seconds a rejected card stays visible so the decision can be undone. */
const UNDO_SECONDS = 5;

/** How many category names show before the `+N` toggle. */
const CATEGORY_PREVIEW = 3;

function formatValue(
  amount: string | null,
  currency: string | null,
  locale: string,
): string | null {
  if (!amount) return null;
  const numeric = Number(amount);
  if (!Number.isFinite(numeric)) return null;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency || "EUR",
      maximumFractionDigits: 0,
    }).format(numeric);
  } catch {
    return `${numeric.toLocaleString(locale)} ${currency ?? ""}`.trim();
  }
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-16 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary/70"
          style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
        />
      </span>
      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
        {Math.round(value * 100)}%
      </span>
    </div>
  );
}

export function TenderCard({
  tender,
  onOpen,
  onDecided,
}: {
  tender: SerializedTender;
  onOpen: (id: string) => void;
  /**
   * Fired once a decision is final: after the undo window for a rejection, or
   * immediately on "To Workspace". The parent drops the card from the feed.
   */
  onDecided: (tenderId: string, status: "deadzone" | "interested") => void;
}) {
  const t = useTranslations("Tenders");
  const format = useFormatter();
  const [showAllCategories, setShowAllCategories] = useState(false);
  const [showBreakdown, setShowBreakdown] = useState(false);

  const [pending, setPending] = useState<"reject" | "workspace" | null>(null);
  const [rejected, setRejected] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const timers = useRef<{ tick?: ReturnType<typeof setInterval>; done?: ReturnType<typeof setTimeout> }>({});

  const clearTimers = () => {
    if (timers.current.tick) clearInterval(timers.current.tick);
    if (timers.current.done) clearTimeout(timers.current.done);
    timers.current = {};
  };
  useEffect(() => clearTimers, []);

  const decide = async (status: "deadzone" | "interested") => {
    const response = await fetch(`/api/tenders/${tender.id}/decision`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  };

  const reject = async () => {
    if (pending) return;
    setPending("reject");
    setFailed(false);
    try {
      await decide("deadzone");
      // Optimistic: card stays put, counting down, until the window closes.
      setRejected(true);
      setCountdown(UNDO_SECONDS);
      timers.current.tick = setInterval(() => {
        setCountdown((value) => (value === null ? null : value - 1));
      }, 1000);
      timers.current.done = setTimeout(() => {
        clearTimers();
        onDecided(tender.id, "deadzone");
      }, UNDO_SECONDS * 1000);
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  const undo = async () => {
    if (pending) return;
    clearTimers();
    setPending("reject");
    try {
      await fetch(`/api/tenders/${tender.id}/decision`, { method: "DELETE" });
      setRejected(false);
      setCountdown(null);
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  const toWorkspace = async () => {
    if (pending) return;
    setPending("workspace");
    setFailed(false);
    try {
      await decide("interested");
      onDecided(tender.id, "interested");
    } catch {
      setFailed(true);
      setPending(null);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Enter/Space on a nested button (match breakdown, category toggle, action
    // bar) must action that button only — without this guard it also opens the
    // detail dialog.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(tender.id);
    }
  };

  const statusStyle =
    STATUS_STYLES[tender.status] ?? "bg-muted text-muted-foreground ring-border";
  const aiMatch = tender.aiMatch ?? null;
  // In AI mode the headline percentage is the blended AI score, so the pill and
  // the breakdown panel below it are always describing the same ranking.
  const matchPct = Math.round(
    (aiMatch ? (aiMatch.fitScore ?? aiMatch.matchScore * 100) / 100 : tender.score) *
      100,
  );
  const value = formatValue(
    tender.estimatedValue.amount,
    tender.estimatedValue.currency,
    "de-DE",
  );
  const daysLeft = tender.submissionDeadline
    ? deadlineDaysLeft(tender.submissionDeadline)
    : null;
  const urgency = daysLeft === null ? null : deadlineUrgency(daysLeft);
  const countdownStyle =
    urgency === "critical" || urgency === "soon" ? COUNTDOWN_STYLES[urgency] : null;

  const categories = tender.categories.length
    ? tender.categories
    : tender.cpvCodes;
  const shownCategories = showAllCategories
    ? categories
    : categories.slice(0, CATEGORY_PREVIEW);
  const categoryExtra = categories.length - shownCategories.length;

  const location = [tender.buyer.postalCode, tender.buyer.city]
    .filter(Boolean)
    .join(" ");
  const inPipeline = tender.pipelineStatus !== null;

  // Nested interactive bits must not open the detail dialog.
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <article
      role="button"
      tabIndex={0}
      data-tour="tender-card"
      onClick={() => onOpen(tender.id)}
      onKeyDown={handleKeyDown}
      className={cn(
        "group flex cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xs transition-shadow hover:border-primary/30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        rejected && "opacity-70",
      )}
    >
      <div className="flex flex-col gap-2.5 px-4 pt-4 pb-3">
        {/* Badge row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${statusStyle}`}
          >
            {t(`status.${tender.status}` as "status.OPEN")}
          </span>

          {/* Match — click reveals the CPV/location/recency breakdown in place. */}
          <span onClick={stop}>
            <button
              type="button"
              onClick={() => setShowBreakdown((value) => !value)}
              aria-expanded={showBreakdown}
              className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/20"
            >
              {t("card.match", { percent: matchPct })}
            </button>
          </span>

          {countdownStyle && daysLeft !== null && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
                countdownStyle,
              )}
            >
              <CalendarClock className="size-3" />
              {daysLeft === 0
                ? t("detail.countdown.closesToday")
                : t("card.daysLeft", { days: daysLeft })}
            </span>
          )}

          {inPipeline && (
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600">
              <Briefcase className="size-3" />
              {t("card.inWorkspace")}
            </span>
          )}
        </div>

        {showBreakdown && (
          <div
            onClick={stop}
            className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2"
          >
            <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("card.breakdown.title")}
            </span>
            {aiMatch && <AiMatchReason match={aiMatch} />}
            <div className="flex flex-col gap-1">
              {aiMatch && (
                <ScoreBar
                  label={t("aiMatched.card.semantic")}
                  value={aiMatch.signals.semantic}
                />
              )}
              <ScoreBar label={t("card.breakdown.cpv")} value={tender.scoreBreakdown.cpv} />
              <ScoreBar label={t("card.breakdown.geo")} value={tender.scoreBreakdown.geo} />
              <ScoreBar label={t("card.breakdown.time")} value={tender.scoreBreakdown.time} />
            </div>
          </div>
        )}

        {/* Title */}
        <h3 className="line-clamp-2 text-[15px] leading-snug font-semibold text-foreground">
          {tender.title ?? "—"}
        </h3>

        {/* Buyer + location + distance */}
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Building2 className="size-3.5 shrink-0" />
            <span className="truncate">{tender.buyer.name ?? "—"}</span>
          </span>
          {(location || tender.distanceKm !== null) && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {location && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="size-3.5 shrink-0" />
                  <span className="truncate font-medium text-foreground/80">
                    {location}
                  </span>
                </span>
              )}
              {tender.distanceKm !== null && (
                <span
                  className="flex items-center gap-1.5"
                  title={t("card.distanceHint")}
                >
                  <Route className="size-3.5 shrink-0 text-primary" />
                  <span className="font-medium text-foreground/80">
                    {t("card.distance", { km: tender.distanceKm })}
                  </span>
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Procedure + deadline + value */}
      <div className="flex flex-col gap-1 border-t border-border/60 px-4 py-2.5 text-xs">
        {tender.procedureType && (
          <span className="font-medium text-foreground/80">
            {tender.procedureType}
          </span>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <span className="text-muted-foreground">
            {t("card.deadline")}:{" "}
            <span
              className={cn(
                "font-medium",
                urgency === "critical" ? "text-red-600" : "text-foreground",
              )}
            >
              {tender.submissionDeadline
                ? format.dateTime(new Date(tender.submissionDeadline), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : t("card.noDeadline")}
            </span>
          </span>
          <span className="text-muted-foreground">
            {t("card.value")}:{" "}
            <span className="font-medium text-foreground">
              {value ?? t("card.notProvided")}
            </span>
          </span>
        </div>
      </div>

      {/* Categories */}
      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
          {shownCategories.map((name, index) => (
            <span
              key={`${name}-${index}`}
              className={cn(
                index < shownCategories.length - 1 &&
                  "border-r border-border pr-2",
              )}
            >
              {name}
            </span>
          ))}
          {categoryExtra > 0 && (
            <button
              type="button"
              onClick={(event) => {
                stop(event);
                setShowAllCategories(true);
              }}
              className="font-medium text-primary hover:underline"
            >
              {t("card.cpvMore", { count: categoryExtra })}
            </button>
          )}
          {showAllCategories && categories.length > CATEGORY_PREVIEW && (
            <button
              type="button"
              onClick={(event) => {
                stop(event);
                setShowAllCategories(false);
              }}
              className="font-medium text-primary hover:underline"
            >
              {t("card.cpvLess")}
            </button>
          )}
        </div>
      )}

      {failed && (
        <p className="border-t border-border/60 px-4 py-2 text-[11px] text-red-600">
          {t("card.decisionError")}
        </p>
      )}

      {/* Action bar — hidden once the tender lives on the board. */}
      {!inPipeline && (
        <div onClick={stop} className="flex h-11 items-center border-t border-border">
          {rejected ? (
            <button
              type="button"
              onClick={undo}
              disabled={pending !== null}
              className="flex h-full flex-1 items-center justify-center gap-2 bg-foreground text-xs font-semibold text-background transition-colors hover:bg-foreground/90 disabled:opacity-50"
            >
              <RotateCcw className="size-4" />
              {countdown !== null
                ? t("card.undoIn", { seconds: Math.max(0, countdown) })
                : t("card.undo")}
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={reject}
                disabled={pending !== null}
                className="flex h-full flex-1 items-center justify-center gap-2 bg-primary/5 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
              >
                {pending === "reject" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ThumbsDown className="size-4" />
                )}
                {t("card.reject")}
              </button>
              <button
                type="button"
                data-tour="tender-card-save"
                onClick={toWorkspace}
                disabled={pending !== null}
                className="flex h-full flex-[1.5] items-center justify-center gap-2 bg-primary text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {pending === "workspace" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <ThumbsUp className="size-4" />
                )}
                {t("card.toWorkspace")}
                <ArrowRightCircle className="size-4" />
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}
