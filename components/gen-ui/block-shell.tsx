"use client";

import {
  Building2,
  CalendarClock,
  FileStack,
  Gauge,
  LayoutGrid,
  ListChecks,
  Maximize2,
  Quote,
  ScanSearch,
  Scale,
  SlidersHorizontal,
  Sparkles,
  SquareStack,
  Tags,
  Target,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { CANVAS_BLOCKS, type BlockKind } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

import { useIrisActions } from "./iris-context";
import { SkeletonLine } from "./primitives";

/**
 * The frame every generative-UI block sits in.
 *
 * The model decides WHICH block appears and in what order; it has no say in
 * how one looks. That split only holds if the chrome is not negotiable — so
 * the header, the icon, the pin affordance and the entry animation live here,
 * and a block component receives a body slot and nothing else.
 */

export const BLOCK_ICONS: Record<BlockKind, LucideIcon> = {
  "metric-summary": Gauge,
  "tender-grid": LayoutGrid,
  "tender-spotlight": Target,
  "tender-compare": Scale,
  "bid-verdict": Sparkles,
  "requirement-checklist": ListChecks,
  "deadline-timeline": CalendarClock,
  "document-shelf": FileStack,
  "evidence-panel": Quote,
  "pipeline-board": SquareStack,
  "cpv-explorer": Tags,
  "company-snapshot": Building2,
  "choice-prompt": ScanSearch,
  "filter-refine": SlidersHorizontal,
};

export function BlockShell({
  kind,
  blockId,
  title,
  caption,
  actions,
  children,
  bare,
  className,
}: {
  kind: BlockKind;
  blockId?: string;
  title: string;
  caption?: string | null;
  actions?: ReactNode;
  children: ReactNode;
  /** Drop the body padding — grids manage their own gutters. */
  bare?: boolean;
  className?: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const { pinBlock, pinnedBlockId } = useIrisActions();
  const Icon = BLOCK_ICONS[kind];
  const canPin = blockId != null && CANVAS_BLOCKS.includes(kind);

  return (
    <section
      className={cn(
        "iris-enter overflow-hidden rounded-2xl border border-border bg-card shadow-[0_1px_2px_rgba(25,23,36,0.04)]",
        className,
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-border/70 bg-linear-to-r from-primary/6 to-transparent px-4 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold tracking-tight text-foreground">
            {title}
          </h3>
          {caption ? (
            <p className="truncate text-[11px] text-muted-foreground">{caption}</p>
          ) : null}
        </div>
        {actions}
        {canPin ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("pin")}
            title={t("pin")}
            onClick={() => pinBlock(blockId)}
            className={cn(
              "text-muted-foreground",
              pinnedBlockId === blockId && "bg-primary/10 text-primary",
            )}
          >
            <Maximize2 />
          </Button>
        ) : null}
      </header>
      <div className={cn(!bare && "p-4")}>{children}</div>
    </section>
  );
}

/**
 * What the reader sees between "the tool started" and "the data landed".
 *
 * Sized per kind rather than a single generic bar: the point of a skeleton is
 * that the layout does not move when the real thing arrives, and a grid, a
 * table and a metric row settle at very different heights.
 */
export function BlockSkeleton({ kind, title }: { kind: BlockKind; title?: string }) {
  const t = useTranslations("GenUi.blocks");
  const Icon = BLOCK_ICONS[kind];

  const rows =
    kind === "metric-summary"
      ? 1
      : kind === "tender-grid" || kind === "pipeline-board"
        ? 3
        : kind === "tender-compare" || kind === "requirement-checklist"
          ? 4
          : 2;

  return (
    <section
      className="iris-enter overflow-hidden rounded-2xl border border-border bg-card"
      aria-busy="true"
      aria-live="polite"
    >
      <header className="flex items-center gap-2.5 border-b border-border/70 px-4 py-2.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <Icon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {title?.trim() || t(`kind.${kind}` as "kind.tender-grid")}
          </p>
          <p className="text-[11px] text-muted-foreground">{t("assembling")}</p>
        </div>
        <span className="size-1.5 rounded-full bg-primary iris-breathe" />
      </header>
      <div className="space-y-2.5 p-4">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <div className="iris-shimmer relative size-9 shrink-0 overflow-hidden rounded-lg bg-muted" />
            <div className="flex-1 space-y-1.5">
              <SkeletonLine className="w-[70%]" />
              <SkeletonLine className="h-2 w-[45%]" />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * A block that could not be filled. Styled as information, not as a failure:
 * "no verdict has been generated yet" is the most common reason, and a red
 * card would teach the user that the product is broken when it is merely
 * empty.
 */
export function BlockNotice({ kind, message }: { kind: BlockKind; message: string }) {
  const t = useTranslations("GenUi.blocks");
  const Icon = BLOCK_ICONS[kind];

  return (
    <section className="iris-enter flex items-start gap-3 rounded-2xl border border-dashed border-border bg-muted/30 px-4 py-3.5">
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-background text-muted-foreground">
        <Icon className="size-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          {t(`kind.${kind}` as "kind.tender-grid")}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{message}</p>
      </div>
    </section>
  );
}
