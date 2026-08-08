"use client";

import { CalendarClock } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { deadlineDaysLeft, deadlineUrgency } from "@/lib/tenders/deadline";

const URGENCY_VARIANT = {
  normal: "neutral",
  soon: "warning",
  critical: "danger",
  closed: "neutral",
} as const;

/**
 * Deadline countdown chip: relative days (ICU plural) + absolute date, with
 * urgency coloring. Renders nothing when the tender has no deadline.
 */
export function DeadlineChip({ deadlineIso }: { deadlineIso: string | null }) {
  const t = useTranslations("Tenders.detail.countdown");
  const format = useFormatter();

  if (!deadlineIso) return null;

  const daysLeft = deadlineDaysLeft(deadlineIso);
  const urgency = deadlineUrgency(daysLeft);
  const relative =
    urgency === "closed"
      ? t("closed")
      : daysLeft === 0
        ? t("closesToday")
        : t("daysLeft", { days: daysLeft });
  const absolute = format.dateTime(new Date(deadlineIso), { dateStyle: "medium" });

  return (
    <Badge
      variant={URGENCY_VARIANT[urgency]}
      className={urgency === "closed" ? "opacity-70" : undefined}
    >
      <CalendarClock />
      <span className="font-semibold">{relative}</span>
      <span className="opacity-70">· {absolute}</span>
    </Badge>
  );
}
