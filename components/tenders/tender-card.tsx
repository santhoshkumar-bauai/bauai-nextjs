"use client";

import {
  Briefcase,
  Building2,
  CalendarClock,
  FileText,
  Loader2,
  MapPin,
  RotateCcw,
  Route,
  Sparkles,
  X,
} from "lucide-react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import { deadlineDaysLeft, deadlineUrgency } from "@/lib/tenders/deadline";
import type { SerializedTender } from "@/lib/tenders/serialize";
import { cn } from "@/lib/utils";

import { AiMatchReason } from "./ai-match-reason";
import type { TenderPanelTab } from "./detail/tender-detail-panel";

const STATUS_STYLES: Record<string, string> = {
  OPEN: "bg-sky-50 text-sky-700 ring-sky-600/20",
  CLOSING_SOON: "bg-amber-50 text-amber-700 ring-amber-600/20",
  UPCOMING: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

/** Fit banding for the headline badge — the same score the pill next to it reports. */
const FIT_STYLES = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  possible: "bg-sky-50 text-sky-700 ring-sky-600/20",
  low: "bg-muted text-muted-foreground ring-border",
} as const;

/**
 * Countdown pill styling per urgency band. Same bands (and therefore the same
 * day count) as the detail panel's `DeadlineChip` — the card must never
 * disagree with the tender it opens.
 */
const COUNTDOWN_STYLES = {
  critical: "bg-red-50 text-red-600 ring-red-600/20",
  soon: "bg-amber-50 text-amber-700 ring-amber-600/20",
} as const;

/** Seconds a rejected card stays visible so the decision can be undone. */
const UNDO_SECONDS = 5;

/** How many category names show before the `+N` toggle. */
const CATEGORY_PREVIEW = 5;

/** Shared look for the two "open this tender at tab X" shortcuts. */
const shortcutButton =
  "inline-flex items-center gap-1.5 rounded-lg border border-primary/25 bg-primary/5 px-2.5 py-1.5 text-[11px] font-semibold text-primary transition-colors hover:border-primary/50 hover:bg-primary/10";

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
      <span className="w-16 shrink-0 text-[10px] text-muted-foreground">
        {label}
      </span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className="block h-full rounded-full bg-primary/70"
          style={{
            width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`,
          }}
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
  selected = false,
  onOpen,
  onDecided,
}: {
  tender: SerializedTender;
  /** Highlighted because the detail pane is showing this tender. */
  selected?: boolean;
  /** Opens the tender in the detail pane, optionally at a given tab. */
  onOpen: (id: string, tab?: TenderPanelTab) => void;
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
  const timers = useRef<{
    tick?: ReturnType<typeof setInterval>;
    done?: ReturnType<typeof setTimeout>;
  }>({});

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
    // detail pane.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(tender.id);
    }
  };

  const statusStyle =
    STATUS_STYLES[tender.status] ??
    "bg-muted text-muted-foreground ring-border";
  const aiMatch = tender.aiMatch ?? null;
  // In AI mode the headline percentage is the blended AI score, so the pill and
  // the breakdown panel below it are always describing the same ranking.
  const matchPct = Math.round(
    (aiMatch
      ? (aiMatch.fitScore ?? aiMatch.matchScore * 100) / 100
      : tender.score) * 100,
  );
  const fitBand = matchPct >= 70 ? "good" : matchPct >= 45 ? "possible" : "low";
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
    urgency === "critical" || urgency === "soon"
      ? COUNTDOWN_STYLES[urgency]
      : null;

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
  // The AI has actually judged this one — not just retrieved it.
  const analyzed =
    aiMatch?.fitScore !== null && aiMatch?.fitScore !== undefined;

  // Nested interactive bits must not open the detail pane.
  const stop = (event: MouseEvent) => {
    event.stopPropagation();
  };

  return (
    <article
      role="button"
      tabIndex={0}
      data-tour="tender-card"
      aria-pressed={selected}
      onClick={() => onOpen(tender.id)}
      onKeyDown={handleKeyDown}
      className={cn(
        "group flex cursor-pointer flex-col gap-2.5 rounded-2xl border bg-card px-4 py-3.5 shadow-xs transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        selected
          ? "border-primary shadow-[0_0_0_1px_var(--color-primary)]"
          : "border-border",
        rejected && "opacity-70",
      )}
    >
      {/* Badge row */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
            FIT_STYLES[fitBand],
          )}
        >
          {t(`card.fit.${fitBand}` as "card.fit.good")}
        </span>

        {/* Match — click reveals the CPV/location/recency breakdown in place. */}
        <span onClick={stop}>
          <button
            type="button"
            onClick={() => setShowBreakdown((value) => !value)}
            aria-expanded={showBreakdown}
            className="rounded-full px-1.5 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10"
          >
            {t("card.match", { percent: matchPct })}
          </button>
        </span>

        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
            statusStyle,
          )}
        >
          {t(`status.${tender.status}` as "status.OPEN")}
        </span>

        {analyzed && (
          <span className="ml-auto inline-flex items-center rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t("card.analyzed")}
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
            <ScoreBar
              label={t("card.breakdown.cpv")}
              value={tender.scoreBreakdown.cpv}
            />
            <ScoreBar
              label={t("card.breakdown.geo")}
              value={tender.scoreBreakdown.geo}
            />
            <ScoreBar
              label={t("card.breakdown.time")}
              value={tender.scoreBreakdown.time}
            />
          </div>
        </div>
      )}

      {/* Title */}
      <h3 className="line-clamp-2 text-[15px] leading-snug font-semibold text-foreground">
        {tender.title ?? "—"}
      </h3>

      {/* Buyer, location, deadline */}
      <div className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Building2 className="size-3.5 shrink-0" />
          <span className="truncate">{tender.buyer.name ?? "—"}</span>
        </span>

        {(location || tender.distanceKm !== null) && (
          <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
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

        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1.5">
            <CalendarClock className="size-3.5 shrink-0" />
            <span
              className={cn(
                "font-medium",
                urgency === "critical" ? "text-red-600" : "text-foreground/80",
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
          {countdownStyle && daysLeft !== null && (
            <span
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset",
                countdownStyle,
              )}
            >
              {daysLeft === 0
                ? t("detail.countdown.closesToday")
                : t("card.daysLeft", { days: daysLeft })}
            </span>
          )}
          {value && (
            <span className="ml-auto font-medium text-foreground/70">
              {value}
            </span>
          )}
        </span>
      </div>

      {/* Categories */}
      {categories.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground">
          {shownCategories.map((name, index) => (
            <span
              key={`${name}-${index}`}
              className={cn(
                "truncate",
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
        <p className="text-[11px] text-red-600">{t("card.decisionError")}</p>
      )}

      {/* Shortcuts into the detail pane + the decision. */}
      <div
        onClick={stop}
        className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5"
      >
        <button
          type="button"
          onClick={() => onOpen(tender.id, "ai")}
          className={shortcutButton}
        >
          <Sparkles className="size-3.5" />
          {t("card.aiAnalysis")}
        </button>
        <button
          type="button"
          onClick={() => onOpen(tender.id, "documents")}
          className={shortcutButton}
        >
          <FileText className="size-3.5" />
          {t("card.fillDocuments")}
        </button>

        <div className="ml-auto flex items-center gap-1.5">
          {inPipeline ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600">
              <Briefcase className="size-3.5" />
              {t("card.inWorkspace")}
            </span>
          ) : rejected ? (
            <button
              type="button"
              onClick={undo}
              disabled={pending !== null}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RotateCcw className="size-3.5" />
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
                className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-red-50 hover:text-red-600 disabled:opacity-50"
              >
                {pending === "reject" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <X className="size-3.5" />
                )}
                {t("card.reject")}
              </button>
              <button
                type="button"
                data-tour="tender-card-save"
                onClick={toWorkspace}
                disabled={pending !== null}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[11px] font-semibold text-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-primary disabled:opacity-50"
              >
                {pending === "workspace" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Briefcase className="size-3.5" />
                )}
                {t("card.toWorkspace")}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
