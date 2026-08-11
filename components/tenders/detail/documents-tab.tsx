"use client";

import {
  Download,
  DownloadCloud,
  ExternalLink,
  FilePenLine,
  FileText,
  Globe,
  Loader2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { SerializedTenderDetail } from "@/lib/tenders/detail";
import type { SerializedTenderFile } from "@/lib/tenders/document-files";
import { workspaceFormat } from "@/lib/onlyoffice/formats";
import type { DocumentFetchState } from "./use-tender-detail";

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function DocumentsTab({
  detail,
  files = [],
  docFetch,
}: {
  detail: SerializedTenderDetail;
  files?: SerializedTenderFile[];
  docFetch?: DocumentFetchState;
}) {
  const t = useTranslations("Tenders");
  const router = useRouter();
  const [copying, setCopying] = useState("");
  const [copyError, setCopyError] = useState("");

  const createWorkingCopy = async (file: SerializedTenderFile) => {
    const key = `${file.recordId}-${file.fileIndex}`;
    setCopying(key);
    setCopyError("");
    try {
      const response = await fetch(`/api/tenders/${detail.id}/documents/working-copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recordId: file.recordId, fileIndex: file.fileIndex }),
      });
      const body = (await response.json()) as { document?: { id: string; state: string }; error?: string };
      if (!response.ok || !body.document) throw new Error(body.error || t("detail.workingCopyFailed"));
      router.push(body.document.state === "ready" ? `/document-filler/${body.document.id}` : "/document-filler");
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : t("detail.workingCopyFailed"));
      setCopying("");
    }
  };

  const summary = docFetch?.summary ?? null;
  // Rows in tender_documents come from the notice's document links, so with no
  // links (and no pre-existing rows) there is nothing a fetch could retrieve.
  const canFetch =
    Boolean(docFetch) &&
    (detail.documents.length > 0 || (summary?.total ?? 0) > 0);

  if (
    !canFetch &&
    files.length === 0 &&
    detail.documents.length === 0 &&
    detail.sourceLinks.length === 0
  ) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {t("detail.noDocuments")}
      </p>
    );
  }

  const active = docFetch?.active ?? false;
  const busy = active || (docFetch?.starting ?? false);
  const done = summary
    ? summary.fetched + summary.skipped + summary.failed
    : 0;

  return (
    <div className="flex flex-col gap-2">
      {canFetch && docFetch && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2">
          <span className="min-w-0 text-xs text-muted-foreground">
            {active && summary
              ? t("detail.fetch.progress", { done, total: summary.total })
              : docFetch.error || (summary?.stalled ?? 0) > 0
                ? t("detail.fetch.error")
                : docFetch.finished && files.length === 0
                  ? t("detail.fetch.noneFound")
                  : t("detail.fetch.hint")}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={docFetch.start}
          >
            {busy ? (
              <Loader2 className="animate-spin" />
            ) : (
              <DownloadCloud />
            )}
            {busy
              ? t("detail.fetch.running")
              : files.length > 0
                ? t("detail.fetch.refresh")
                : t("detail.fetch.button")}
          </Button>
        </div>
      )}
      {files.length > 0 && (
        <p className="pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("detail.filesHeading")}
        </p>
      )}
      {copyError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{copyError}</p>}
      {files.map((file) => (
        <div
          key={`${file.recordId}-${file.fileIndex}`}
          className="group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
        >
          <FileText className="size-4 shrink-0 text-primary/70" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">{file.fileName}</span>
            <span className="truncate text-[11px] text-muted-foreground">
              {formatBytes(file.byteLength)} · {file.mimeType}
            </span>
          </span>
          {file.textStatus !== "DONE" && (
            <Badge variant="neutral" className="shrink-0">
              {t("detail.fileNotReadable")}
            </Badge>
          )}
          {workspaceFormat(file.fileName) && (
            <Button
              size="sm"
              variant="outline"
              disabled={copying === `${file.recordId}-${file.fileIndex}`}
              onClick={() => void createWorkingCopy(file)}
            >
              {copying === `${file.recordId}-${file.fileIndex}` ? <Loader2 className="animate-spin" /> : <FilePenLine />}
              {t("detail.createWorkingCopy")}
            </Button>
          )}
          <a
            href={`/api/tenders/${detail.id}/documents?record=${encodeURIComponent(file.recordId)}&file=${file.fileIndex}`}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-muted"
            title={t("detail.downloadFile")}
          >
            <Download className="size-4" />
          </a>
        </div>
      ))}
      {files.length > 0 &&
        (detail.documents.length > 0 || detail.sourceLinks.length > 0) && (
          <p className="pt-2 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {t("detail.linksHeading")}
          </p>
        )}
      {detail.documents.map((doc, index) => (
        <a
          key={`${doc.url}-${index}`}
          href={doc.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-foreground">
              {doc.kind ?? t("detail.document")}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {doc.url}
            </span>
          </span>
          {doc.restricted && (
            <Badge variant="warning" className="shrink-0">
              {t("detail.restricted")}
            </Badge>
          )}
          <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </a>
      ))}
      {detail.sourceLinks
        .filter((link) => link.url)
        .map((link, index) => (
          <a
            key={`${link.url}-${index}`}
            href={link.url as string}
            target="_blank"
            rel="noopener noreferrer"
            className="group flex items-center gap-3 rounded-lg border border-dashed border-border p-3 transition-colors hover:border-primary/40 hover:bg-muted/50"
          >
            <Globe className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm text-foreground">
                {t("detail.sourcePortal")} · {link.source}
              </span>
              <span className="truncate text-[11px] text-muted-foreground">
                {link.url}
              </span>
            </span>
            <ExternalLink className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
          </a>
        ))}
    </div>
  );
}
