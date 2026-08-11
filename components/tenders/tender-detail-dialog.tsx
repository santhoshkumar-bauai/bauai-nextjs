"use client";

import { Maximize2 } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import type { DecisionStatus } from "@/lib/tenders/pipeline-status";
import { ClaraAssistant } from "./detail/clara-assistant";
import { TenderDecisionActions } from "./detail/decision-actions";
import { TenderDetailTabs } from "./detail/detail-tabs";
import { DeadlineChip } from "./detail/header-summary";
import { buyerLine, useTenderDetail } from "./detail/use-tender-detail";

export function TenderDetailDialog({
  tenderId,
  onClose,
  onDecided,
  initialTab,
}: {
  tenderId: string | null;
  onClose: () => void;
  /** Fired when the popup's action bar changes this tender's pipeline state. */
  onDecided?: (tenderId: string, status: DecisionStatus | null) => void;
  /** Which tab opens first — e.g. "documents" when launched from the kanban board. */
  initialTab?: "about" | "documents" | "schedule" | "ai";
}) {
  const t = useTranslations("Tenders");
  const { detail, files, decision, setDecision, loading, error, fit, docFetch } =
    useTenderDetail(tenderId);

  return (
    <Dialog open={tenderId !== null} onOpenChange={(open) => !open && onClose()}>
      {/* No `relative` here: tailwind-merge would replace the popup's `fixed`
          positioning and break centering. The popup's transform already makes
          it the containing block for the floating assistant. */}
      <DialogContent className="h-[85svh] max-h-[720px] max-w-3xl">
        <DialogHeader className="pr-20">
          <DialogTitle className="pr-2">
            {loading ? t("detail.loading") : (detail?.title ?? "—")}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span>{buyerLine(detail) || " "}</span>
            {detail && <DeadlineChip deadlineIso={detail.submissionDeadline} />}
          </DialogDescription>
        </DialogHeader>

        {/* Sits left of the popup's own close button (which is `right-4`). */}
        {tenderId && (
          <Link
            href={`/tenders/${tenderId}`}
            aria-label={t("detail.expand")}
            title={t("detail.expand")}
            className="absolute top-4 right-14 grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            <Maximize2 className="size-4" />
          </Link>
        )}

        {loading ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-16 w-1/2" />
          </div>
        ) : error || !detail ? (
          <div className="grid min-h-0 flex-1 place-items-center text-sm text-muted-foreground">
            {t("states.errorTitle")}
          </div>
        ) : (
          <TenderDetailTabs
            tenderId={tenderId}
            detail={detail}
            files={files}
            docFetch={docFetch}
            className="flex min-h-0 flex-1 flex-col gap-0"
            listWrapperClassName="border-b border-border px-6 py-3"
            panelClassName="min-h-0 flex-1 overflow-y-auto px-6 py-4"
            initialTab={initialTab}
          />
        )}

        {detail && !loading && tenderId && (
          <>
            {/* `pr-20` keeps the buttons clear of the floating assistant. */}
            <DialogFooter className="py-3 pr-20 sm:justify-start">
              <TenderDecisionActions
                tenderId={tenderId}
                status={decision}
                onChange={(status) => {
                  setDecision(status);
                  onDecided?.(tenderId, status);
                }}
              />
            </DialogFooter>
            <ClaraAssistant tenderId={tenderId} fit={fit} />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
