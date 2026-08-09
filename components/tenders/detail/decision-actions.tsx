"use client";

import {
  ArrowRightCircle,
  Briefcase,
  Loader2,
  RotateCcw,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  isPipelineStatus,
  type DecisionStatus,
} from "@/lib/tenders/pipeline-status";
import { cn } from "@/lib/utils";

/**
 * "To Workspace" / "Reject" for a single tender, as shown on the detail popup
 * and the full-page view. Same endpoint as the feed card's action bar, but no
 * countdown: nothing disappears here, so the decision is reversible for as long
 * as the tender is on screen rather than for five seconds.
 */
export function TenderDecisionActions({
  tenderId,
  status,
  onChange,
  className,
}: {
  tenderId: string;
  status: DecisionStatus | null;
  onChange: (status: DecisionStatus | null) => void;
  className?: string;
}) {
  const t = useTranslations("Tenders");
  const [pending, setPending] = useState<"reject" | "workspace" | "undo" | null>(
    null,
  );
  const [failed, setFailed] = useState(false);

  const decide = async (next: DecisionStatus) => {
    if (pending) return;
    setPending(next === "deadzone" ? "reject" : "workspace");
    setFailed(false);
    try {
      const response = await fetch(`/api/tenders/${tenderId}/decision`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onChange(next);
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  const undo = async () => {
    if (pending) return;
    setPending("undo");
    setFailed(false);
    try {
      const response = await fetch(`/api/tenders/${tenderId}/decision`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onChange(null);
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  const inPipeline = isPipelineStatus(status);

  return (
    <div className={cn("flex flex-col items-stretch gap-1.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        {inPipeline ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 ring-1 ring-inset ring-emerald-600/20">
              <Briefcase className="size-3.5" />
              {t("card.inWorkspace")}
            </span>
            <Link
              href="/kanban"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              {t("detail.openWorkspace")}
              <ArrowRightCircle className="size-3.5" />
            </Link>
            <UndoButton onClick={undo} pending={pending === "undo"} label={t("card.undo")} />
          </>
        ) : status === "deadzone" ? (
          <>
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
              <ThumbsDown className="size-3.5" />
              {t("detail.rejected")}
            </span>
            <UndoButton onClick={undo} pending={pending === "undo"} label={t("card.undo")} />
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => decide("deadzone")}
              disabled={pending !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/5 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10 disabled:opacity-50"
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
              onClick={() => decide("interested")}
              disabled={pending !== null}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
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
      {failed && (
        <p className="text-[11px] text-red-600">{t("card.decisionError")}</p>
      )}
    </div>
  );
}

function UndoButton({
  onClick,
  pending,
  label,
}: {
  onClick: () => void;
  pending: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RotateCcw className="size-3.5" />
      )}
      {label}
    </button>
  );
}
