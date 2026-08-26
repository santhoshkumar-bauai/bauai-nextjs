"use client";

import { PanelRightClose, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import type { BlockKind, BlockState } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

import { BLOCK_ICONS } from "./block-shell";
import { IrisBlock } from "./block-renderer";

/**
 * The pinned-artifact panel.
 *
 * Conversations about a tender are a loop: read the verdict, ask about a risk,
 * read the answer, look back at the verdict. In a single column that means
 * scrolling past four blocks each time, and by the third loop the reader has
 * lost the thing they were reasoning about. So the blocks worth KEEPING open —
 * spotlight, comparison, verdict, checklist (`CANVAS_BLOCKS`) — get pinned
 * here, with tabs for the ones from earlier in the session.
 *
 * The panel is desktop-only by design. On a phone the same split would leave
 * two unusable columns; there the blocks simply stay inline, which is the
 * correct reading experience at that width.
 */

export interface CanvasEntry {
  id: string;
  state: Extract<BlockState<BlockKind>, { status: "ready" }>;
}

export function IrisCanvas({
  entries,
  pinnedId,
  onPin,
  onClose,
}: {
  entries: CanvasEntry[];
  pinnedId: string | null;
  onPin: (id: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("GenUi.canvas");
  // Tab labels reuse the block catalog's own names rather than a second list.
  const tKind = useTranslations("GenUi.blocks");
  const active = entries.find((entry) => entry.id === pinnedId) ?? entries[entries.length - 1];
  if (!active) return null;

  return (
    <aside className="hidden w-[27rem] shrink-0 flex-col border-l border-border bg-[#fbfafc] lg:flex">
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <PanelRightClose className="size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("title")}
        </p>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          aria-label={t("close")}
          className="ml-auto text-muted-foreground"
        >
          <X />
        </Button>
      </header>

      {entries.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-2 py-1.5">
          {entries.map((entry) => {
            const Icon = BLOCK_ICONS[entry.state.kind];
            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onPin(entry.id)}
                className={cn(
                  "flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
                  entry.id === active.id
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-muted",
                )}
              >
                <Icon className="size-3" />
                {tKind(`kind.${entry.state.kind}` as "kind.tender-spotlight")}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <IrisBlock key={active.id} state={active.state} blockId={active.id} />
      </div>
    </aside>
  );
}
