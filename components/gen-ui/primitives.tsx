"use client";

import { CalendarClock } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ComponentProps, ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

/**
 * The small visual vocabulary every Iris block shares.
 *
 * The blocks are generated one at a time by a model, in an order nobody
 * designed, and they end up stacked in a single column. If each one invented
 * its own way to show a score, a deadline or a status, the result would read
 * as fourteen different products. So the shared pieces live here and the
 * blocks compose them.
 */

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  primary: "text-primary",
  positive: "text-emerald-700",
  warning: "text-amber-700",
  critical: "text-rose-700",
};

export const TONE_BADGE: Record<Tone, ComponentProps<typeof Badge>["variant"]> = {
  neutral: "neutral",
  primary: "primary",
  positive: "success",
  warning: "warning",
  critical: "danger",
};

export const TONE_BAR: Record<Tone, string> = {
  neutral: "bg-muted-foreground/40",
  primary: "bg-primary",
  positive: "bg-emerald-500",
  warning: "bg-amber-500",
  critical: "bg-rose-500",
};

/** Days-to-deadline → tone. The one place the thresholds are decided. */
export function deadlineTone(daysLeft: number | null | undefined): Tone {
  if (daysLeft == null) return "neutral";
  if (daysLeft <= 7) return "critical";
  if (daysLeft <= 21) return "warning";
  return "positive";
}

// ---------------------------------------------------------------------------
// Score display
// ---------------------------------------------------------------------------

/**
 * A 0..1 value as a ring. Used for match scores and verdict axes, where the
 * question is "roughly how much" and a two-decimal number would imply a
 * precision the ranking does not have.
 */
export function ScoreRing({
  value,
  size = 44,
  label,
  tone = "primary",
}: {
  value: number;
  size?: number;
  label?: string;
  tone?: Tone;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const stroke = size >= 40 ? 4 : 3;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label ? `${label}: ` : ""}${Math.round(clamped * 100)}%`}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-muted"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          className={cn(
            "transition-[stroke-dashoffset] duration-700 ease-out",
            tone === "primary" && "stroke-primary",
            tone === "positive" && "stroke-emerald-500",
            tone === "warning" && "stroke-amber-500",
            tone === "critical" && "stroke-rose-500",
            tone === "neutral" && "stroke-muted-foreground/50",
          )}
        />
      </svg>
      <span
        className="absolute inset-0 flex items-center justify-center font-semibold tabular-nums"
        style={{ fontSize: size >= 40 ? 12 : 10 }}
      >
        {Math.round(clamped * 100)}
      </span>
    </div>
  );
}

/** A 0..1 value as a bar, for stacks of axes where rings would not line up. */
export function ScoreBar({
  value,
  tone = "primary",
  className,
}: {
  value: number;
  tone?: Tone;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full transition-[width] duration-700 ease-out", TONE_BAR[tone])}
        style={{ width: `${clamped * 100}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/**
 * The countdown chip. Every surface that shows a tender shows one, so the
 * overdue / this-week / this-month reading is identical everywhere.
 */
export function DeadlinePill({
  daysLeft,
  className,
}: {
  daysLeft: number | null | undefined;
  className?: string;
}) {
  const t = useTranslations("GenUi.blocks");
  if (daysLeft == null) return null;

  const overdue = daysLeft < 0;
  return (
    <Badge
      variant={overdue ? "neutral" : TONE_BADGE[deadlineTone(daysLeft)]}
      className={className}
    >
      <CalendarClock />
      {overdue ? t("closed") : t("daysLeft", { days: daysLeft })}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Layout atoms
// ---------------------------------------------------------------------------

/** Label above a value, the unit every block uses for a single fact. */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-sm text-foreground">{children}</dd>
    </div>
  );
}

/** Neutral in-block empty state. Never an alarm — usually nothing is wrong. */
export function BlockEmpty({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border bg-muted/40 px-4 py-6 text-center text-xs text-muted-foreground">
      {message}
    </p>
  );
}

export function SkeletonLine({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "iris-shimmer relative h-3 overflow-hidden rounded-full bg-muted",
        className,
      )}
    />
  );
}
