"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Download, History, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";

import { Button, buttonVariants } from "@/components/ui/button";
import { DoraPanel } from "@/components/dora/dora-panel";
import type { SerializedWorkspaceVersion } from "@/lib/onlyoffice/serialize";
import { cn } from "@/lib/utils";

import { ConfirmDialog } from "./confirm-dialog";
import { OnlyOfficeEditorClient } from "./editor-client";

type VersionItem = SerializedWorkspaceVersion & { restorable: boolean };

export function EditorWorkspace({
  documentId,
  fileName,
  aiAvailable = false,
  nativeDora = false,
}: {
  documentId: string;
  fileName: string;
  aiAvailable?: boolean;
  /** The editor hosts the native Dora panel — hide the legacy sidebar. */
  nativeDora?: boolean;
}) {
  const t = useTranslations("DocumentFiller.editor");
  const tDora = useTranslations("Dora");
  const [state, setState] = useState("connecting");
  const [versions, setVersions] = useState<VersionItem[] | null>(null);
  const [restoring, setRestoring] = useState<{ versionId: string; storageRevision: number } | null>(null);
  const [busy, setBusy] = useState("");
  const [doraOpen, setDoraOpen] = useState(true);

  const loadVersions = async () => {
    setBusy("versions");
    const response = await fetch(`/api/workspace-documents/${documentId}/versions`, { cache: "no-store" });
    const body = (await response.json()) as { items?: VersionItem[] };
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
  const confirmRestore = async () => {
    if (!restoring) return;
    setBusy(`restore:${restoring.versionId}`);
    const response = await fetch(
      `/api/workspace-documents/${documentId}/versions/${restoring.versionId}/restore`,
      { method: "POST" },
    );
    if (response.ok) {
      location.reload();
    } else {
      setBusy("");
      setRestoring(null);
    }
  };

  const statusKey = ["connecting", "ready", "editing", "saved", "error"].includes(state)
    ? (state as "connecting" | "ready" | "editing" | "saved" | "error")
    : null;

  return (
    <main className="flex h-svh min-h-0 flex-col bg-white">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
        <Link
          href="/document-filler"
          aria-label={t("back")}
          title={t("back")}
          className={buttonVariants({ variant: "ghost", size: "icon" })}
        >
          <ArrowLeft />
        </Link>
        <Image src="/brand/logo_small.svg" width={28} height={28} alt="BAU AI" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-foreground">{fileName}</h1>
          <p className="text-[11px] text-muted-foreground">{statusKey ? t(`status.${statusKey}`) : state}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          title={t("download")}
          aria-label={t("download")}
          disabled={busy === "download:current"}
          onClick={() => void download()}
        >
          {busy === "download:current" ? <Loader2 className="animate-spin" /> : <Download />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={t("versions")}
          aria-label={t("versions")}
          disabled={busy === "versions"}
          onClick={() => void loadVersions()}
        >
          {busy === "versions" ? <Loader2 className="animate-spin" /> : <History />}
        </Button>
        {!nativeDora && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDoraOpen(!doraOpen)}
            className={cn(
              "hidden md:flex",
              doraOpen && "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary",
            )}
            title={tDora("title")}
          >
            <Sparkles />
            {tDora("title")}
          </Button>
        )}
      </header>
      <div className="flex min-h-0 flex-1">
        <section className="min-h-0 min-w-0 flex-1">
          <OnlyOfficeEditorClient documentId={documentId} onStateChange={setState} />
        </section>
        {!nativeDora && doraOpen && (
          <aside className="hidden w-[400px] shrink-0 border-l border-border md:block">
            <DoraPanel documentId={documentId} aiAvailable={aiAvailable} onClose={() => setDoraOpen(false)} />
          </aside>
        )}
      </div>

      {versions && (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-[1px] motion-safe:[animation:tender-tab-in_150ms_ease-out]"
          onClick={() => setVersions(null)}
        >
          <aside
            className="h-full w-full max-w-md overflow-y-auto border-l border-border bg-card p-5 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-foreground">{t("versions")}</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("close")}
                title={t("close")}
                onClick={() => setVersions(null)}
              >
                <X />
              </Button>
            </div>
            {versions.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">{t("versionsEmpty")}</p>
            ) : (
              <ul className="mt-5 grid gap-2">
                {versions.map((version) => (
                  <li key={version.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <strong className="text-sm text-foreground">
                          {t("version", { n: version.storageRevision })}
                        </strong>
                        <p className="mt-0.5 text-xs text-muted-foreground capitalize">
                          {version.reason} · {version.createdAt ? new Date(version.createdAt).toLocaleString() : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t("download")}
                          aria-label={t("download")}
                          disabled={busy === `download:${version.id}`}
                          onClick={() => void download(version.id)}
                        >
                          {busy === `download:${version.id}` ? <Loader2 className="animate-spin" /> : <Download />}
                        </Button>
                        {version.restorable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            title={t("restore")}
                            aria-label={t("restore")}
                            onClick={() =>
                              setRestoring({ versionId: version.id, storageRevision: version.storageRevision })
                            }
                          >
                            <RotateCcw />
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={t("restoreTitle")}
        description={restoring ? t("restoreDescription", { n: restoring.storageRevision }) : ""}
        confirmLabel={t("restoreConfirm")}
        cancelLabel={t("restoreCancel")}
        busy={busy === `restore:${restoring?.versionId}`}
        onConfirm={() => void confirmRestore()}
      />
    </main>
  );
}
