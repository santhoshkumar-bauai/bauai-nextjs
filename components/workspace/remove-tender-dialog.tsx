"use client";

import { Check } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { PipelineItem } from "./kanban-columns";

/**
 * Two-step removal, as in mvp1: parking a tender in the dead zone is the
 * default and is reversible; opting into the second choice dismisses it for
 * good. Note "permanently" is scoped to this company — the tender itself is
 * shared corpus data and is never destroyed.
 */
export function RemoveTenderDialog({
  item,
  onClose,
  onConfirm,
}: {
  item: PipelineItem | null;
  onClose: () => void;
  onConfirm: (permanent: boolean) => void | Promise<void>;
}) {
  const t = useTranslations("Workspace.kanban.remove");
  const [permanent, setPermanent] = useState(false);

  // Reset on every exit path, so the next tender starts from the safe choice
  // rather than inheriting the previous one's opt-in.
  const close = () => {
    setPermanent(false);
    onClose();
  };

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 px-6 py-4">
          <Option
            checked
            disabled
            title={t("deadzone.title")}
            description={t("deadzone.description")}
            onClick={() => setPermanent(false)}
          />
          <Option
            checked={permanent}
            title={t("permanent.title")}
            description={t("permanent.description")}
            onClick={() => setPermanent((value) => !value)}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
          <button
            type="button"
            onClick={close}
            className="rounded-lg border border-border px-4 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            {t("cancel")}
          </button>
          <button
            type="button"
            onClick={() => {
              void onConfirm(permanent);
              setPermanent(false);
            }}
            className={cn(
              "rounded-lg px-4 py-2 text-xs font-semibold text-white transition-colors",
              permanent
                ? "bg-red-600 hover:bg-red-700"
                : "bg-foreground hover:bg-foreground/90",
            )}
          >
            {permanent ? t("confirmPermanent") : t("confirm")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Option({
  checked,
  disabled = false,
  title,
  description,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-disabled={disabled}
      onClick={disabled ? undefined : onClick}
      className={cn(
        "flex items-start gap-3 rounded-xl border px-3 py-3 text-left transition-colors",
        checked ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/50",
        disabled && "cursor-default",
      )}
    >
      <span
        className={cn(
          "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full",
          checked ? "bg-primary text-primary-foreground" : "border border-border",
        )}
      >
        {checked && <Check className="size-3" strokeWidth={3} />}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-xs font-semibold text-foreground">{title}</span>
        <span className="text-[11px] text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
