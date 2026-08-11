"use client";

import Link from "next/link";
import { Download, FileSpreadsheet, FileText, FileType2, History, Loader2, Pencil, RotateCcw, Trash2, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import type { SerializedWorkspaceDocument, SerializedWorkspaceVersion } from "@/lib/onlyoffice/serialize";
import { WORKSPACE_ACCEPT, WORKSPACE_MAX_FILE_BYTES, validateWorkspaceFile } from "@/lib/onlyoffice/formats";

function icon(type: SerializedWorkspaceDocument["documentType"]) {
  if (type === "cell") return <FileSpreadsheet className="text-emerald-600" />;
  if (type === "pdf") return <FileType2 className="text-red-600" />;
  return <FileText className="text-blue-600" />;
}

export function DocumentLibrary({
  initialDocuments,
  canDelete,
}: {
  initialDocuments: SerializedWorkspaceDocument[];
  canDelete: boolean;
}) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [versions, setVersions] = useState<{ document: SerializedWorkspaceDocument; items: Array<SerializedWorkspaceVersion & { restorable: boolean }> } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const upload = async (file: File) => {
    const validation = validateWorkspaceFile({ fileName: file.name, size: file.size });
    if ("error" in validation) {
      setError(validation.error === "file_too_large" ? "Files must be 100 MB or smaller." : "Choose a DOC, DOCX, XLS, XLSX, or PDF file.");
      return;
    }
    setBusy("upload"); setError("");
    try {
      const intentResponse = await fetch("/api/workspace-documents/upload-url", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: file.name, contentType: file.type, size: file.size }),
      });
      const intent = (await intentResponse.json()) as { uploadUrl?: string; uploadToken?: string; headers?: Record<string, string>; error?: string };
      if (!intentResponse.ok || !intent.uploadUrl || !intent.uploadToken) throw new Error(intent.error || "Upload could not be started.");
      const put = await fetch(intent.uploadUrl, { method: "PUT", headers: intent.headers, body: file });
      if (!put.ok) throw new Error("The file could not be uploaded.");
      const confirm = await fetch("/api/workspace-documents", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ uploadToken: intent.uploadToken }),
      });
      const result = (await confirm.json()) as { document?: SerializedWorkspaceDocument; error?: string };
      if (!confirm.ok || !result.document) throw new Error(result.error || "The upload could not be confirmed.");
      setDocuments((current) => [result.document!, ...current]);
      router.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed.");
    } finally { setBusy(""); }
  };
  const download = async (documentId: string, versionId?: string) => {
    setBusy(`download:${versionId ?? documentId}`);
    const response = await fetch(`/api/workspace-documents/${documentId}/download${versionId ? `?versionId=${versionId}` : ""}`);
    const body = (await response.json()) as { downloadUrl?: string };
    if (body.downloadUrl) window.open(body.downloadUrl, "_blank", "noopener,noreferrer");
    setBusy("");
  };
  const loadVersions = async (document: SerializedWorkspaceDocument) => {
    setBusy(`versions:${document.id}`);
    const response = await fetch(`/api/workspace-documents/${document.id}/versions`, { cache: "no-store" });
    const body = (await response.json()) as { items?: Array<SerializedWorkspaceVersion & { restorable: boolean }> };
    if (response.ok) setVersions({ document, items: body.items ?? [] });
    setBusy("");
  };
  const rename = async (document: SerializedWorkspaceDocument) => {
    const fileName = prompt("Document name", document.fileName);
    if (!fileName) return;
    const response = await fetch(`/api/workspace-documents/${document.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ fileName }) });
    const body = (await response.json()) as { document?: SerializedWorkspaceDocument };
    if (body.document) setDocuments((current) => current.map((item) => item.id === document.id ? body.document! : item));
  };
  const remove = async (document: SerializedWorkspaceDocument) => {
    if (!confirm(`Permanently delete ${document.fileName} and every saved version?`)) return;
    setBusy(`delete:${document.id}`);
    const response = await fetch(`/api/workspace-documents/${document.id}`, { method: "DELETE" });
    if (response.ok) setDocuments((current) => current.filter((item) => item.id !== document.id));
    else setError("The document could not be deleted. It may still be open in the editor.");
    setBusy("");
  };
  const restore = async (documentId: string, versionId: string) => {
    if (!confirm("Restore this version as a new current version?")) return;
    setBusy(`restore:${versionId}`);
    const response = await fetch(`/api/workspace-documents/${documentId}/versions/${versionId}/restore`, { method: "POST" });
    if (response.ok) { setVersions(null); router.refresh(); }
    else setError("The version could not be restored. Close active editors and try again.");
    setBusy("");
  };

  const shown = documents.filter((document) =>
    sourceFilter === "all" ? true : sourceFilter === "tender" ? Boolean(document.tenderId) : !document.tenderId,
  );
  return (
    <div className="h-full overflow-y-auto p-5 sm:p-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div><p className="text-xs font-bold uppercase tracking-[.14em] text-primary">Bid preparation</p><h1 className="mt-1 text-2xl font-bold">Document Filler</h1><p className="mt-1 text-sm text-muted-foreground">Edit tender working copies with your team and Clara.</p></div>
          <><input ref={input} className="hidden" type="file" accept={WORKSPACE_ACCEPT} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void upload(file); }} /><button disabled={busy === "upload"} onClick={() => input.current?.click()} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50">{busy === "upload" ? <Loader2 className="animate-spin" /> : <Upload />} Upload document</button></>
        </header>
        <div className="mt-7 flex items-center justify-between gap-3"><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="h-9 rounded-lg border bg-white px-3 text-sm"><option value="all">All documents</option><option value="tender">Tender working copies</option><option value="upload">Direct uploads</option></select><span className="text-xs text-muted-foreground">{WORKSPACE_MAX_FILE_BYTES / 1_000_000} MB max · DOCX, XLSX, PDF</span></div>
        {error && <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
        <div className="mt-4 overflow-hidden rounded-2xl border bg-white shadow-sm">
          {shown.length === 0 ? <div className="grid place-items-center px-6 py-20 text-center"><FileText className="mb-3 size-9 text-muted-foreground" /><h2 className="font-semibold">No documents yet</h2><p className="mt-1 text-sm text-muted-foreground">Upload a document or create a working copy from a tender.</p></div> : <ul className="divide-y">{shown.map((document) => <li key={document.id} className="flex items-center gap-3 p-4 hover:bg-muted/30"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">{icon(document.documentType)}</span><div className="min-w-0 flex-1"><Link href={document.state === "ready" ? `/document-filler/${document.id}` : "#"} className="block truncate text-sm font-semibold hover:text-primary">{document.fileName}</Link><p className="text-xs text-muted-foreground">{document.tenderId ? "Tender working copy" : "Uploaded document"} · <span className="capitalize">{document.state.replaceAll("_", " ")}</span> · v{document.storageRevision}</p></div><div className="flex gap-1"><button onClick={() => void rename(document)} className="grid size-8 place-items-center rounded-lg hover:bg-muted" title="Rename"><Pencil /></button><button onClick={() => void download(document.id)} className="grid size-8 place-items-center rounded-lg hover:bg-muted" title="Download"><Download /></button><button onClick={() => void loadVersions(document)} className="grid size-8 place-items-center rounded-lg hover:bg-muted" title="Versions">{busy === `versions:${document.id}` ? <Loader2 className="animate-spin" /> : <History />}</button>{canDelete && <button onClick={() => void remove(document)} className="grid size-8 place-items-center rounded-lg text-red-600 hover:bg-red-50" title="Delete">{busy === `delete:${document.id}` ? <Loader2 className="animate-spin" /> : <Trash2 />}</button>}</div></li>)}</ul>}
        </div>
      </div>
      {versions && <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4" onClick={() => setVersions(null)}><section className="max-h-[80vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl" onClick={(event) => event.stopPropagation()}><h2 className="font-semibold">Version history · {versions.document.fileName}</h2><ul className="mt-4 grid gap-2">{versions.items.map((version) => <li key={version.id} className="flex items-center gap-3 rounded-xl border p-3"><div className="flex-1"><strong className="text-sm">Version {version.storageRevision}</strong><p className="text-xs capitalize text-muted-foreground">{version.reason} · {version.createdAt ? new Date(version.createdAt).toLocaleString() : ""}</p></div><button onClick={() => void download(versions.document.id, version.id)} className="grid size-8 place-items-center rounded-lg hover:bg-muted"><Download /></button>{version.restorable && <button onClick={() => void restore(versions.document.id, version.id)} className="grid size-8 place-items-center rounded-lg hover:bg-muted">{busy === `restore:${version.id}` ? <Loader2 className="animate-spin" /> : <RotateCcw />}</button>}</li>)}</ul></section></div>}
    </div>
  );
}
