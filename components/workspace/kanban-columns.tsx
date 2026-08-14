"use client";

import {
  ArrowLeft,
  CalendarClock,
  Inbox,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useFormatter, useTranslations } from "next-intl";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { TenderDetailDialog } from "@/components/tenders/tender-detail-dialog";
import { cn } from "@/lib/utils";
import { RemoveTenderDialog } from "./remove-tender-dialog";
import styles from "./workspace-pages.module.css";

export type KanbanColumn = {
  key: string;
  title: string;
  color: string;
  tint: string;
};

export interface PipelineItem {
  tenderId: string;
  status: string;
  assigneeUserId: string | null;
  title: string | null;
  buyerName: string | null;
  buyerCity: string | null;
  tenderStatus: string | null;
  submissionDeadline: string | null;
  movedAt: string | null;
}

export interface CompanyMember {
  userId: string;
  email: string;
  name: string;
  role: string;
}

interface PipelineResponse {
  items: PipelineItem[];
  deadzone: PipelineItem[];
  members: CompanyMember[];
}

const initials = (name: string) =>
  name
    .split(/[.\-_\s]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";

/**
 * The company's tender pipeline. Cards are dragged between columns (native HTML5
 * drag and drop — no extra dependency), each carries an assignee, and removing
 * one either parks it in the dead zone or dismisses it for good.
 */
export function KanbanBoardClient({
  title,
  workspaceLabel,
  deadZoneLabel,
  noTenders,
  emptyHint,
  columns,
}: {
  title: string;
  workspaceLabel: string;
  deadZoneLabel: string;
  noTenders: string;
  emptyHint: string;
  columns: KanbanColumn[];
}) {
  const t = useTranslations("Workspace.kanban");
  const format = useFormatter();

  const [data, setData] = useState<PipelineResponse | null>(null);
  const [view, setView] = useState<"board" | "deadzone">("board");
  const [busy, setBusy] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [removing, setRemoving] = useState<PipelineItem | null>(null);
  // Which card's full tender detail is open — opened straight to the
  // Documents tab, so "click a card" doubles as "see its files and start a
  // working copy" without leaving the board.
  const [viewing, setViewing] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    return fetch("/api/tenders/pipeline", { signal })
      .then((response) =>
        response.ok ? response.json() : { items: [], deadzone: [], members: [] },
      )
      .then((json: PipelineResponse) => setData(json))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const patch = async (
    tenderId: string,
    body: { status: string; assigneeUserId?: string | null },
  ) => {
    setBusy(tenderId);
    try {
      await fetch(`/api/tenders/${tenderId}/decision`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } finally {
      await load();
      setBusy(null);
    }
  };

  const moveTo = async (item: PipelineItem, status: string) => {
    if (item.status === status) return;
    // Optimistic: the card lands in the new column before the round-trip.
    setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((entry) =>
              entry.tenderId === item.tenderId ? { ...entry, status } : entry,
            ),
          }
        : prev,
    );
    await patch(item.tenderId, { status });
  };

  const restore = (item: PipelineItem) =>
    patch(item.tenderId, { status: "interested" });

  const items = data?.items ?? [];
  const deadzone = data?.deadzone ?? [];
  const members = data?.members ?? [];
  const memberById = new Map(members.map((member) => [member.userId, member]));
  const loading = data === null;
  const boardEmpty = !loading && items.length === 0;

  const onDrop = (event: DragEvent, columnKey: string) => {
    event.preventDefault();
    setDropTarget(null);
    setDragging(null);
    const tenderId = event.dataTransfer.getData("text/plain");
    const item = items.find((entry) => entry.tenderId === tenderId);
    if (item) void moveTo(item, columnKey);
  };

  return (
    <div className={styles.kanbanPage}>
      <header className={styles.kanbanHeader}>
        <div className={styles.pipelineTitle}>
          <ArrowLeft size={15} />
          <strong>{title}</strong>
          <span>{t("tenderCountValue", { count: items.length })}</span>
        </div>
        <div className={styles.headerActions}>
          <button type="button" className={styles.roundAction} aria-hidden="true">
            <UsersRound size={16} />
          </button>
          <button type="button" className={styles.roundAction} aria-hidden="true">
            <UserPlus size={16} />
          </button>
          <div className={styles.viewSwitch}>
            <button
              type="button"
              onClick={() => setView("board")}
              className={cn(
                "cursor-pointer border-0 bg-transparent",
                view === "board" && styles.activeView,
              )}
            >
              {workspaceLabel}
            </button>
            <button
              type="button"
              onClick={() => setView("deadzone")}
              className={cn(
                "cursor-pointer border-0 bg-transparent",
                view === "deadzone" && styles.activeView,
              )}
            >
              {deadZoneLabel}
              {deadzone.length > 0 ? ` (${deadzone.length})` : ""}
            </button>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            aria-label={t("refresh")}
            className="cursor-pointer border-0 bg-transparent text-inherit"
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </header>

      {loading ? (
        <div className="grid place-items-center py-24 text-[#6b6f7a]">
          <Loader2 className="animate-spin" size={20} />
        </div>
      ) : view === "deadzone" ? (
        <DeadZone
          items={deadzone}
          busy={busy}
          onRestore={restore}
          emptyLabel={t("deadZoneEmpty")}
          restoreLabel={t("restore")}
        />
      ) : boardEmpty ? (
        <EmptyBoard
          title={t("emptyTitle")}
          description={t("emptyDescription")}
          cta={t("exploreTenders")}
        />
      ) : (
        <div data-tour="kanban-board" className={styles.boardScroller}>
          <div className={styles.board}>
            {columns.map((column) => {
              const columnItems = items.filter(
                (item) => item.status === column.key,
              );
              return (
                <section
                  key={column.key}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDropTarget(column.key);
                  }}
                  onDragLeave={() => setDropTarget((key) =>
                    key === column.key ? null : key,
                  )}
                  onDrop={(event) => onDrop(event, column.key)}
                  className={cn(
                    styles.column,
                    dropTarget === column.key && "ring-2 ring-[var(--column-color)]",
                  )}
                  style={
                    {
                      "--column-color": column.color,
                      "--column-tint": column.tint,
                    } as CSSProperties
                  }
                >
                  <header className={styles.columnHeader}>
                    <strong>{column.title}</strong>
                    <span>{columnItems.length}</span>
                  </header>
                  <div className={styles.columnBody}>
                    {columnItems.length === 0 ? (
                      <div className={styles.emptyState}>
                        <span className={styles.emptyIcon}>
                          <Inbox size={18} />
                        </span>
                        <strong>{noTenders}</strong>
                        <p>{emptyHint}</p>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-2">
                        {columnItems.map((item) => (
                          <article
                            key={item.tenderId}
                            role="button"
                            tabIndex={0}
                            aria-label={t("openTender", { title: item.title ?? "" })}
                            draggable
                            onClick={() => setViewing(item.tenderId)}
                            onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
                              if (event.target !== event.currentTarget) return;
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                setViewing(item.tenderId);
                              }
                            }}
                            onDragStart={(event) => {
                              event.dataTransfer.setData("text/plain", item.tenderId);
                              event.dataTransfer.effectAllowed = "move";
                              setDragging(item.tenderId);
                            }}
                            onDragEnd={() => {
                              setDragging(null);
                              setDropTarget(null);
                            }}
                            className={cn(
                              "group flex cursor-grab flex-col gap-1.5 rounded-xl border border-[#e8eaf0] bg-white p-3 shadow-[0_2px_8px_rgba(25,31,49,.04)] transition-shadow active:cursor-grabbing hover:border-primary/30 hover:shadow-[0_4px_14px_rgba(25,31,49,.09)] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
                              dragging === item.tenderId && "opacity-50",
                              busy === item.tenderId && "opacity-60",
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <strong className="line-clamp-2 text-xs leading-snug font-semibold text-[#22262f]">
                                {item.title ?? "—"}
                              </strong>
                              <button
                                type="button"
                                onClick={(event: MouseEvent) => {
                                  event.stopPropagation();
                                  setRemoving(item);
                                }}
                                aria-label={t("remove.trigger")}
                                className="shrink-0 cursor-pointer rounded-md border-0 bg-transparent p-0.5 text-[#9aa0ad] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#d33a26] focus-visible:opacity-100"
                              >
                                <X size={13} />
                              </button>
                            </div>

                            <span className="truncate text-[11px] text-[#6b6f7a]">
                              {[item.buyerName, item.buyerCity]
                                .filter(Boolean)
                                .join(" · ") || "—"}
                            </span>

                            {item.submissionDeadline && (
                              <span className="flex items-center gap-1 text-[11px] text-[#6b6f7a]">
                                <CalendarClock size={12} />
                                {format.dateTime(new Date(item.submissionDeadline), {
                                  dateStyle: "medium",
                                })}
                              </span>
                            )}

                            <span
                              onClick={(event: MouseEvent) => event.stopPropagation()}
                            >
                              <AssigneePicker
                                item={item}
                                members={members}
                                assignee={
                                  item.assigneeUserId
                                    ? (memberById.get(item.assigneeUserId) ?? null)
                                    : null
                                }
                                onAssign={(userId) =>
                                  patch(item.tenderId, {
                                    status: item.status,
                                    assigneeUserId: userId,
                                  })
                                }
                              />
                            </span>
                          </article>
                        ))}
                      </div>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      )}

      <RemoveTenderDialog
        item={removing}
        onClose={() => setRemoving(null)}
        onConfirm={async (permanent) => {
          const item = removing;
          setRemoving(null);
          if (!item) return;
          await patch(item.tenderId, {
            status: permanent ? "deleted" : "deadzone",
          });
        }}
      />

      {/* Opens straight to the Documents tab — from here a working copy can be
          created and edited in the Document Filler without leaving the board. */}
      <TenderDetailDialog
        tenderId={viewing}
        onClose={() => setViewing(null)}
        initialTab="documents"
        onDecided={() => void load()}
      />
    </div>
  );
}

function AssigneePicker({
  item,
  members,
  assignee,
  onAssign,
}: {
  item: PipelineItem;
  members: CompanyMember[];
  assignee: CompanyMember | null;
  onAssign: (userId: string | null) => void | Promise<void>;
}) {
  const t = useTranslations("Workspace.kanban");
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="mt-0.5 inline-flex cursor-pointer items-center gap-1.5 self-start rounded-full border-0 bg-transparent px-0 py-0.5 text-[11px] text-[#6b6f7a] hover:text-[#3146ed]">
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full text-[9px] font-bold",
            assignee
              ? "bg-[#eef1ff] text-[#3146ed]"
              : "border border-dashed border-[#c9cdd8] text-[#9aa0ad]",
          )}
        >
          {assignee ? initials(assignee.name) : "+"}
        </span>
        <span className="max-w-[110px] truncate">
          {assignee?.name ?? t("unassigned")}
        </span>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-56">
        <div className="flex flex-col gap-0.5">
          <span className="px-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("assignTo")}
          </span>
          {members.map((member) => (
            <button
              key={member.userId}
              type="button"
              onClick={() => {
                void onAssign(member.userId);
                setOpen(false);
              }}
              className={cn(
                "flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                member.userId === item.assigneeUserId &&
                  "bg-muted font-medium text-foreground",
              )}
            >
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-[#eef1ff] text-[9px] font-bold text-[#3146ed]">
                {initials(member.name)}
              </span>
              <span className="min-w-0 flex-1 truncate">{member.name}</span>
            </button>
          ))}
          {item.assigneeUserId && (
            <button
              type="button"
              onClick={() => {
                void onAssign(null);
                setOpen(false);
              }}
              className="mt-1 rounded-lg border-t border-border px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
            >
              {t("unassign")}
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeadZone({
  items,
  busy,
  onRestore,
  emptyLabel,
  restoreLabel,
}: {
  items: PipelineItem[];
  busy: string | null;
  onRestore: (item: PipelineItem) => void | Promise<void>;
  emptyLabel: string;
  restoreLabel: string;
}) {
  if (items.length === 0) {
    return (
      <div className="grid place-items-center gap-2 py-24 text-center text-[#6b6f7a]">
        <Inbox size={22} />
        <p className="text-sm">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="grid gap-2 px-6 py-4 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <article
          key={item.tenderId}
          className="flex items-start justify-between gap-3 rounded-xl border border-[#e8eaf0] bg-white p-3 shadow-[0_2px_8px_rgba(25,31,49,.04)]"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <strong className="line-clamp-2 text-xs leading-snug font-semibold text-[#22262f]">
              {item.title ?? "—"}
            </strong>
            <span className="truncate text-[11px] text-[#6b6f7a]">
              {[item.buyerName, item.buyerCity].filter(Boolean).join(" · ") || "—"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => void onRestore(item)}
            disabled={busy === item.tenderId}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-[#d8dbe4] bg-white px-2 py-1 text-[11px] font-semibold text-[#3146ed] transition-colors hover:border-[#3146ed] disabled:opacity-50"
          >
            {busy === item.tenderId ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <RotateCcw size={12} />
            )}
            {restoreLabel}
          </button>
        </article>
      ))}
    </div>
  );
}

function EmptyBoard({
  title,
  description,
  cta,
}: {
  title: string;
  description: string;
  cta: string;
}) {
  return (
    <div className="grid place-items-center px-6 py-20">
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        <span className="grid size-14 place-items-center rounded-full bg-[#eef1ff] text-[#3146ed]">
          <Inbox size={24} />
        </span>
        <strong className="text-base font-semibold text-[#22262f]">{title}</strong>
        <p className="text-sm text-[#6b6f7a]">{description}</p>
        <Link
          href="/tenders"
          className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-[#3146ed] px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[#2637d4]"
        >
          <Search size={14} />
          {cta}
        </Link>
      </div>
    </div>
  );
}
