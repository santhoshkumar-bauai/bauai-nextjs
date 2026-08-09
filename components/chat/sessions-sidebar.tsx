"use client";

import { Check, FileText, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useFormatter, useNow, useTranslations } from "next-intl";

import type { WireThreadSummary } from "@/lib/ai/agent/wire";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

function SessionRow({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: WireThreadSummary;
  active: boolean;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const t = useTranslations("Chat.sessions");
  const format = useFormatter();
  // Explicit reference time; refreshed each minute so labels stay current.
  const now = useNow({ updateInterval: 60_000 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState(false);

  const label =
    session.kind === "tender"
      ? (session.tenderTitle ?? t("untitled"))
      : (session.title ?? t("untitled"));

  if (editing) {
    return (
      <div className="flex items-center gap-1 rounded-lg px-2 py-1.5">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim()) {
              onRename(draft.trim());
              setEditing(false);
            }
            if (event.key === "Escape") setEditing(false);
          }}
          maxLength={80}
          autoFocus
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:border-ring"
        />
        <button
          type="button"
          aria-label={t("save")}
          onClick={() => {
            if (draft.trim()) onRename(draft.trim());
            setEditing(false);
          }}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <Check className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label={t("cancel")}
          onClick={() => setEditing(false)}
          className="rounded p-1 text-muted-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="flex items-center justify-between gap-1 rounded-lg bg-muted/60 px-2.5 py-1.5">
        <span className="truncate text-xs text-foreground">{t("deleteConfirm")}</span>
        <span className="flex shrink-0 items-center">
          <button
            type="button"
            aria-label={t("delete")}
            onClick={onDelete}
            className="rounded p-1 text-rose-600 hover:bg-rose-50"
          >
            <Check className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label={t("cancel")}
            onClick={() => setConfirming(false)}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group flex items-center gap-1 rounded-lg px-2.5 py-1.5 transition-colors",
        active ? "bg-primary/10" : "hover:bg-muted/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
      >
        <span
          className={cn(
            "flex w-full items-center gap-1.5 truncate text-xs font-medium",
            active ? "text-primary" : "text-foreground",
          )}
        >
          {session.kind === "tender" && (
            <FileText className="size-3 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{label}</span>
        </span>
        <span className="text-[10px] text-muted-foreground">
          {format.relativeTime(new Date(session.lastMessageAt), now)}
        </span>
      </button>
      <span className="hidden shrink-0 items-center group-hover:flex">
        {session.kind === "global" && (
          <button
            type="button"
            aria-label={t("rename")}
            title={t("rename")}
            onClick={() => {
              setDraft(session.title ?? "");
              setEditing(true);
            }}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3" />
          </button>
        )}
        <button
          type="button"
          aria-label={t("delete")}
          title={t("delete")}
          onClick={() => setConfirming(true)}
          className="rounded p-1 text-muted-foreground hover:text-rose-600"
        >
          <Trash2 className="size-3" />
        </button>
      </span>
    </div>
  );
}

export function SessionsSidebar({
  sessions,
  loading,
  activeThreadId,
  onSelect,
  onNewChat,
  onRename,
  onDelete,
}: {
  sessions: WireThreadSummary[];
  loading: boolean;
  activeThreadId: string | null;
  onSelect: (session: WireThreadSummary) => void;
  onNewChat: () => void;
  onRename: (threadId: string, title: string) => void;
  onDelete: (threadId: string) => void;
}) {
  const t = useTranslations("Chat.sessions");
  // Empty "New conversation" shells (created but never messaged) are noise —
  // show them only while active. Abandoned ones stay hidden until deleted.
  const globalSessions = sessions.filter(
    (session) =>
      session.kind === "global" &&
      (session.messageCount > 0 || session.id === activeThreadId),
  );
  const tenderSessions = sessions.filter((session) => session.kind === "tender");

  return (
    <aside className="flex h-full w-full flex-col gap-3 overflow-hidden">
      <button
        type="button"
        onClick={onNewChat}
        className="flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2 text-xs font-medium text-foreground shadow-sm transition-colors hover:border-primary/40 hover:text-primary"
      >
        <Plus className="size-3.5" />
        {t("newChat")}
      </button>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {loading ? (
          <div className="space-y-2 pt-1">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        ) : (
          <>
            {globalSessions.length > 0 && (
              <div>
                <p className="px-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {t("chats")}
                </p>
                <div className="flex flex-col gap-0.5">
                  {globalSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === activeThreadId}
                      onSelect={() => onSelect(session)}
                      onRename={(title) => onRename(session.id, title)}
                      onDelete={() => onDelete(session.id)}
                    />
                  ))}
                </div>
              </div>
            )}
            {tenderSessions.length > 0 && (
              <div>
                <p className="px-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {t("tenderChats")}
                </p>
                <div className="flex flex-col gap-0.5">
                  {tenderSessions.map((session) => (
                    <SessionRow
                      key={session.id}
                      session={session}
                      active={session.id === activeThreadId}
                      onSelect={() => onSelect(session)}
                      onRename={(title) => onRename(session.id, title)}
                      onDelete={() => onDelete(session.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
