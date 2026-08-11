"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Download, History, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { DoraPanel } from "@/components/dora/dora-panel";
import type { SerializedWorkspaceVersion } from "@/lib/onlyoffice/serialize";
import { cn } from "@/lib/utils";

import { OnlyOfficeEditorClient } from "./editor-client";

export function EditorWorkspace({
  documentId,
  fileName,
  aiAvailable = false,
}: {
  documentId: string;
  fileName: string;
  aiAvailable?: boolean;
}) {
  const t = useTranslations("Dora");
  const [state, setState] = useState("connecting");
  const [versions, setVersions] = useState<Array<SerializedWorkspaceVersion & { restorable: boolean }> | null>(null);
  const [busy, setBusy] = useState("");
  const [doraOpen, setDoraOpen] = useState(true);

  const loadVersions = async () => {
    setBusy("versions");
    const response = await fetch(`/api/workspace-documents/${documentId}/versions`, { cache: "no-store" });
    const body = (await response.json()) as { items?: Array<SerializedWorkspaceVersion & { restorable: boolean }> };
    if (response.ok) setVersions(body.items ?? []);
    setBusy("");
  };
  const download = async (versionId?: string) => {
    setBusy(`download:${versionId ?? "current"}`);
    const suffix = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
    const response = await fetch(`/api/workspace-documents/${documentId}/download${suffix}`);
    const body = (await response.json()) as { downloadUrl?: string };
    if (body.downloadUrl) window.open(body.downloadUrl, "_blank", "noopener,noreferrer");
    setBusy("");
  };
  const restore = async (versionId: string) => {
    if (!confirm("Restore this version as the current document?")) return;
    setBusy(`restore:${versionId}`);
    const response = await fetch(
      `/api/workspace-documents/${documentId}/versions/${versionId}/restore`,
      { method: "POST" },
    );
    if (response.ok) location.reload();
    else setBusy("");
  };

  return (
    <main className="flex h-svh min-h-0 flex-col bg-white">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b px-3 sm:px-5">
        <Link href="/document-filler" className="grid size-8 place-items-center rounded-lg hover:bg-muted" aria-label="Back">
          <ArrowLeft />
        </Link>
        <Image src="/brand/logo_small.svg" width={28} height={28} alt="BAU AI" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">{fileName}</h1>
          <p className="text-[11px] capitalize text-muted-foreground">{state}</p>
        </div>
        <button onClick={() => void download()} className="grid size-8 place-items-center rounded-lg hover:bg-muted" title="Download">
          {busy === "download:current" ? <Loader2 className="animate-spin" /> : <Download />}
        </button>
        <button onClick={() => void loadVersions()} className="grid size-8 place-items-center rounded-lg hover:bg-muted" title="Version history">
          {busy === "versions" ? <Loader2 className="animate-spin" /> : <History />}
        </button>
        <button
          onClick={() => setDoraOpen(!doraOpen)}
          className={cn(
            "hidden h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium md:flex",
            doraOpen ? "border-primary/30 bg-primary/5 text-primary" : "hover:bg-muted",
          )}
          title={t("title")}
        >
          <Sparkles className="size-3.5" />
          {t("title")}
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <section className="min-h-0 min-w-0 flex-1">
          <OnlyOfficeEditorClient documentId={documentId} onStateChange={setState} />
        </section>
        {doraOpen && (
          <aside className="hidden w-[400px] shrink-0 border-l border-border md:block">
            <DoraPanel
              documentId={documentId}
              aiAvailable={aiAvailable}
              onClose={() => setDoraOpen(false)}
            />
          </aside>
        )}
      </div>
      {versions && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/25" onClick={() => setVersions(null)}>
          <aside className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold">Version history</h2>
              <button onClick={() => setVersions(null)} className="grid size-8 place-items-center rounded-lg hover:bg-muted"><X /></button>
            </div>
            <ul className="mt-5 grid gap-2">
              {versions.map((version) => (
                <li key={version.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div><strong className="text-sm">Version {version.storageRevision}</strong><p className="text-xs text-muted-foreground">{version.reason} · {version.createdAt ? new Date(version.createdAt).toLocaleString() : ""}</p></div>
                    <div className="flex gap-1">
                      <button onClick={() => void download(version.id)} className="grid size-8 place-items-center rounded-lg hover:bg-muted"><Download /></button>
                      {version.restorable && <button onClick={() => void restore(version.id)} className="grid size-8 place-items-center rounded-lg hover:bg-muted" title="Restore">{busy === `restore:${version.id}` ? <Loader2 className="animate-spin" /> : <RotateCcw />}</button>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}
    </main>
  );
}
