"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { FileText, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";

import type { SerializedFillSession } from "@/lib/ai/fill-agent/store";
import { UploadDropzone } from "./upload-dropzone";

/** POC landing: upload a form, list existing sessions. */
export function FillChatHome({ maxPages }: { maxPages: number }) {
  const t = useTranslations("FillAgent");
  const router = useRouter();
  const [sessions, setSessions] = useState<SerializedFillSession[] | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/poc/fill-chat/sessions");
      if (!response.ok) return;
      const json = (await response.json()) as { sessions: SerializedFillSession[] };
      setSessions(json.sessions);
    } catch {
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const remove = async (id: string) => {
    await fetch(`/api/poc/fill-chat/${id}`, { method: "DELETE" }).catch(() => {});
    void load();
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8">
      <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
      <p className="pb-6 text-sm text-muted-foreground">{t("subtitle")}</p>

      <UploadDropzone
        maxPages={maxPages}
        onCreated={(id) => router.push(`/poc/fill-chat/${id}`)}
      />

      <h2 className="pt-8 pb-2 text-sm font-medium text-foreground">{t("sessions")}</h2>
      {sessions == null ? (
        <p className="text-xs text-muted-foreground">{t("sessionsLoading")}</p>
      ) : sessions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
          {t("sessionsEmpty")}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border">
          {sessions.map((session) => (
            <li key={session.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() => router.push(`/poc/fill-chat/${session.id}`)}
                className="min-w-0 flex-1 text-left"
              >
                <p className="truncate text-sm font-medium text-foreground">
                  {session.fileName}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {session.documentClass} · {session.pageCount}p ·{" "}
                  {session.score != null
                    ? `${t("score")} ${session.score.toFixed(2)}`
                    : t("noScore")}{" "}
                  · {new Date(session.createdAt).toLocaleDateString()}
                </p>
              </button>
              <button
                type="button"
                onClick={() => void remove(session.id)}
                aria-label={t("deleteSession")}
                title={t("deleteSession")}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600"
              >
                <Trash2 className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
