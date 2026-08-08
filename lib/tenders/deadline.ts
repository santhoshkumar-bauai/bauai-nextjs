/**
 * Deadline countdown helpers for the tender UI. Calendar-day based: "3 days
 * left" means three date boundaries away in the viewer's local timezone,
 * matching how bidders reason about deadlines.
 */

export type DeadlineUrgency = "closed" | "critical" | "soon" | "normal";

/** Whole calendar days between now and the deadline; negative = past. */
export function deadlineDaysLeft(deadlineIso: string, now: Date = new Date()): number {
  const deadline = new Date(deadlineIso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDeadlineDay = new Date(
    deadline.getFullYear(),
    deadline.getMonth(),
    deadline.getDate(),
  );
  const MS_PER_DAY = 86_400_000;
  return Math.round((startOfDeadlineDay.getTime() - startOfToday.getTime()) / MS_PER_DAY);
}

/**
 * Urgency band for the countdown chip. A deadline later today counts as
 * critical, not closed — the actual cut-off time may still be ahead.
 */
export function deadlineUrgency(daysLeft: number): DeadlineUrgency {
  if (daysLeft < 0) return "closed";
  if (daysLeft < 7) return "critical";
  if (daysLeft <= 14) return "soon";
  return "normal";
}
