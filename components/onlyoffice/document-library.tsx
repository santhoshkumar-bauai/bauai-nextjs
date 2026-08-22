"use client";

import {
  Download,
  FileSpreadsheet,
  FileText,
  FileType2,
  History,
  ListTree,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type DragEvent } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { WORKSPACE_ACCEPT, WORKSPACE_MAX_FILE_BYTES, validateWorkspaceFile } from "@/lib/onlyoffice/formats";
import type { SerializedWorkspaceDocument, SerializedWorkspaceVersion } from "@/lib/onlyoffice/serialize";
import { cn } from "@/lib/utils";

import { ConfirmDialog } from "./confirm-dialog";

type SourceFilter = "all" | "tender" | "upload";
type VersionItem = SerializedWorkspaceVersion & { restorable: boolean };

function TypeIcon({ type }: { type: SerializedWorkspaceDocument["documentType"] }) {
  if (type === "cell") return <FileSpreadsheet className="text-emerald-600" />;
  if (type === "pdf") return <FileType2 className="text-red-600" />;
  if (type === "gaeb") return <ListTree className="text-amber-600" />;
  return <FileText className="text-blue-600" />;
}

function StateBadge({
  state,
  t,
}: {
  state: SerializedWorkspaceDocument["state"];
  t: ReturnType<typeof useTranslations>;
}) {
  if (state === "converting") {
    return (
      <Badge variant="warning">
        <Loader2 className="animate-spin" />
        {t("state.converting")}
      </Badge>
    );
  }
  if (state === "conversion_failed") {
    return <Badge variant="danger">{t("state.conversionFailed")}</Badge>;
  }
  if (state === "ready") {
    return <Badge variant="success">{t("state.ready")}</Badge>;
  }
  return <Badge variant="neutral">{state}</Badge>;
}

function formatDate(iso: string | null) {
  return iso ? new Date(iso).toLocaleString() : "";
}

/**
 * The Document Filler landing page — every working copy and direct upload the
 * company has, with upload, rename, download, version history, and delete.
 * Tender working copies also start life here once created from a tender's
 * Documents tab (see `DocumentsTab` and the kanban board).
 */
export function DocumentLibrary({
  initialDocuments,
  canDelete,
}: {
  initialDocuments: SerializedWorkspaceDocument[];
  canDelete: boolean;
}) {
  const t = useTranslations("DocumentFiller.library");
  const [documents, setDocuments] = useState(initialDocuments);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [versions, setVersions] = useState<{
    document: SerializedWorkspaceDocument;
    items: VersionItem[];
  } | null>(null);
  const [renaming, setRenaming] = useState<SerializedWorkspaceDocument | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleting, setDeleting] = useState<SerializedWorkspaceDocument | null>(null);
  const [restoring, setRestoring] = useState<{
    documentId: string;
    versionId: string;
    storageRevision: number;
  } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const upload = async (file: File) => {
    const validation = validateWorkspaceFile({ fileName: file.name, size: file.size });
    if ("error" in validation) {
      setError(
        validation.error === "file_too_large" ? t("errors.fileTooLarge") : t("errors.unsupportedType"),
      );
      return;
    }
    setBusy("upload");
    setError("");
    try {
      const intentResponse = await fetch("/api/workspace-documents/upload-url", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size }),
      });
      const intent = (await intentResponse.json()) as {
        uploadUrl?: string;
        uploadToken?: string;
        headers?: Record<string, string>;
        error?: string;
      };
      if (!intentResponse.ok || !intent.uploadUrl || !intent.uploadToken) {
        throw new Error(intent.error || t("errors.uploadStartFailed"));
      }
      const put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
      if (!put.ok) throw new Error(t("errors.uploadFailed"));
      const confirm = await fetch("/api/workspace-documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadToken: intent.uploadToken }),
      });
      const result = (await confirm.json()) as { document?: SerializedWorkspaceDocument; error?: string };
      if (!confirm.ok || !result.document) throw new Error(result.error || t("errors.uploadConfirmFailed"));
      setDocuments((current) => [result.document!, ...current]);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("errors.uploadFailed"));
    } finally {
      setBusy("");
    }
  };

  const download = async (documentId: string, versionId?: string) => {
    setBusy(`download:${versionId ?? documentId}`);
    const response = await fetch(
      `/api/workspace-documents/${documentId}/download${versionId ? `?versionId=${versionId}` : ""}`,
    );
    const body = (await response.json()) as { downloadUrl?: string };
    if (body.downloadUrl) window.open(body.downloadUrl, "_blank", "noopener,noreferrer");
    setBusy("");
  };

  const loadVersions = async (document: SerializedWorkspaceDocument) => {
    setBusy(`versions:${document.id}`);
    const response = await fetch(`/api/workspace-documents/${document.id}/versions`, { cache: "no-store" });
    const body = (await response.json()) as { items?: VersionItem[] };
    if (response.ok) setVersions({ document, items: body.items ?? [] });
    setBusy("");
  };

  const openRename = (document: SerializedWorkspaceDocument) => {
    setRenameValue(document.fileName);
    setRenaming(document);
  };
  const submitRename = async () => {
    if (!renaming) return;
    const fileName = renameValue.trim();
    if (!fileName) return;
    setBusy(`rename:${renaming.id}`);
    const response = await fetch(`/api/workspace-documents/${renaming.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileName }),
    });
    const body = (await response.json()) as { document?: SerializedWorkspaceDocument; error?: string };
    if (body.document) {
      setDocuments((current) => current.map((item) => (item.id === renaming.id ? body.document! : item)));
      setRenaming(null);
    } else {
      setError(body.error || t("errors.renameFailed"));
    }
    setBusy("");
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusy(`delete:${deleting.id}`);
    const response = await fetch(`/api/workspace-documents/${deleting.id}`, { method: "DELETE" });
    if (response.ok) {
      setDocuments((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(null);
    } else {
      setError(t("errors.deleteFailed"));
    }
    setBusy("");
  };

  const confirmRestore = async () => {
    if (!restoring) return;
    setBusy(`restore:${restoring.versionId}`);
    const response = await fetch(
      `/api/workspace-documents/${restoring.documentId}/versions/${restoring.versionId}/restore`,
      { method: "POST" },
    );
    if (response.ok) {
      setRestoring(null);
      setVersions(null);
      router.refresh();
    } else {
      setError(t("errors.restoreFailed"));
    }
    setBusy("");
  };

  const shown = documents.filter((document) =>
    sourceFilter === "all" ? true : sourceFilter === "tender" ? Boolean(document.tenderId) : !document.tenderId,
  );

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void upload(file);
  };

  return (
    <div
      className="flex flex-col gap-4"
      onDragOver={(event) => {
        event.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs value={sourceFilter} onValueChange={(value) => setSourceFilter(value as SourceFilter)}>
          <TabsList>
            <TabsTrigger value="all">{t("filter.all")}</TabsTrigger>
            <TabsTrigger value="tender">{t("filter.tender")}</TabsTrigger>
            <TabsTrigger value="upload">{t("filter.upload")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {t("sizeHint", { mb: WORKSPACE_MAX_FILE_BYTES / 1_000_000 })}
          </span>
          <input
            ref={input}
            className="hidden"
            type="file"
            accept={WORKSPACE_ACCEPT}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
          <Button
            data-tour="document-upload"
            disabled={busy === "upload"}
            onClick={() => input.current?.click()}
          >
            {busy === "upload" ? <Loader2 className="animate-spin" /> : <Upload />}
            {busy === "upload" ? t("uploading") : t("upload")}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      <div>
        <div
          className={cn(
            "overflow-hidden rounded-2xl border bg-card shadow-xs transition-colors",
            dragOver ? "border-primary/50 bg-primary/5" : "border-border",
          )}
        >
          {shown.length === 0 ? (
            <div
              className={cn(
                "m-3 grid place-items-center gap-3 rounded-xl border-2 border-dashed px-6 py-20 text-center",
                dragOver ? "border-primary/50" : "border-border",
              )}
            >
              <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
                <FileText className="size-5" />
              </span>
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t("empty.title")}</h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{t("empty.description")}</p>
              </div>
              <Button variant="outline" onClick={() => input.current?.click()}>
                <Upload />
                {t("upload")}
              </Button>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {shown.map((document) => (
                <li
                  key={document.id}
                  className="flex items-center gap-3 p-4 transition-colors hover:bg-muted/40"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
                    <TypeIcon type={document.documentType} />
                  </span>
                  <div className="min-w-0 flex-1">
                    {document.state === "ready" ? (
                      <Link
                        href={`/document-filler/${document.id}`}
                        className="block truncate text-sm font-semibold text-foreground hover:text-primary"
                      >
                        {document.fileName}
                      </Link>
                    ) : (
                      <span className="block truncate text-sm font-semibold text-muted-foreground">
                        {document.fileName}
                      </span>
                    )}
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{document.tenderId ? t("source.tender") : t("source.upload")}</span>
                      <StateBadge state={document.state} t={t} />
                      <span>{t("version", { n: document.storageRevision })}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("actions.rename")}
                      aria-label={t("actions.rename")}
                      onClick={() => openRename(document)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("actions.download")}
                      aria-label={t("actions.download")}
                      disabled={busy === `download:${document.id}`}
                      onClick={() => void download(document.id)}
                    >
                      {busy === `download:${document.id}` ? <Loader2 className="animate-spin" /> : <Download />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("actions.versions")}
                      aria-label={t("actions.versions")}
                      onClick={() => void loadVersions(document)}
                    >
                      {busy === `versions:${document.id}` ? <Loader2 className="animate-spin" /> : <History />}
                    </Button>
                    {canDelete && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("actions.delete")}
                        aria-label={t("actions.delete")}
                        className="text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleting(document)}
                      >
                        {busy === `delete:${document.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("rename.title")}</DialogTitle>
            <DialogDescription>{t("rename.description")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <label className="flex flex-col gap-1.5 text-xs font-semibold text-foreground" htmlFor="document-rename">
              {t("rename.label")}
              <Input
                id="document-rename"
                value={renameValue}
                autoFocus
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename();
                }}
              />
            </label>
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              {t("rename.cancel")}
            </Button>
            <Button
              onClick={() => void submitRename()}
              disabled={!renameValue.trim() || busy === `rename:${renaming?.id}`}
            >
              {busy === `rename:${renaming?.id}` && <Loader2 className="animate-spin" />}
              {t("rename.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("delete.title")}
        description={deleting ? t("delete.description", { name: deleting.fileName }) : ""}
        confirmLabel={t("delete.confirm")}
        cancelLabel={t("delete.cancel")}
        destructive
        busy={busy === `delete:${deleting?.id}`}
        onConfirm={() => void confirmDelete()}
      />

      <ConfirmDialog
        open={restoring !== null}
        onOpenChange={(open) => !open && setRestoring(null)}
        title={t("versions.restoreTitle")}
        description={
          restoring ? t("versions.restoreDescription", { n: restoring.storageRevision }) : ""
        }
        confirmLabel={t("versions.restoreConfirm")}
        cancelLabel={t("versions.restoreCancel")}
        busy={busy === `restore:${restoring?.versionId}`}
        onConfirm={() => void confirmRestore()}
      />

      <Dialog open={versions !== null} onOpenChange={(open) => !open && setVersions(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("versions.title")}</DialogTitle>
            <DialogDescription>{versions?.document.fileName}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {versions && versions.items.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t("versions.empty")}</p>
            ) : (
              <ul className="grid gap-2">
                {versions?.items.map((version) => (
                  <li key={version.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
                    <div className="min-w-0 flex-1">
                      <strong className="text-sm text-foreground">
                        {t("versions.version", { n: version.storageRevision })}
                      </strong>
                      <p className="mt-0.5 text-xs text-muted-foreground capitalize">
                        {version.reason} · {formatDate(version.createdAt)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      title={t("actions.download")}
                      aria-label={t("actions.download")}
                      disabled={busy === `download:${version.id}`}
                      onClick={() => void download(versions!.document.id, version.id)}
                    >
                      {busy === `download:${version.id}` ? <Loader2 className="animate-spin" /> : <Download />}
                    </Button>
                    {version.restorable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("versions.restore")}
                        aria-label={t("versions.restore")}
                        onClick={() =>
                          setRestoring({
                            documentId: versions!.document.id,
                            versionId: version.id,
                            storageRevision: version.storageRevision,
                          })
                        }
                      >
                        <RotateCcw />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </div>
  );
}
