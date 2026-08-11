"use client";

import {
  ArrowLeft,
  Building2,
  CalendarClock,
  Download,
  DownloadCloud,
  ExternalLink,
  FilePenLine,
  FileSpreadsheet,
  FileText,
  FileType2,
  Inbox,
  Loader2,
  Search,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { workspaceFormat } from "@/lib/onlyoffice/formats";
import type { SerializedWorkspaceDocument } from "@/lib/onlyoffice/serialize";
import type { TenderDocumentFetchSummary } from "@/lib/tenders/document-fetch";
import type { SerializedTenderFile } from "@/lib/tenders/document-files";

/** The subset of `/api/tenders/pipeline` items this browser renders. */
interface BoardTender {
  tenderId: string;
  status: string;
  title: string | null;
  buyerName: string | null;
  buyerCity: string | null;
  submissionDeadline: string | null;
}

const STATUS_VARIANT: Record<
  string,
  "info" | "warning" | "primary" | "success" | "danger"
> = {
  interested: "info",
  preparing: "warning",
  submitted: "primary",
  won: "success",
  lost: "danger",
};

const POLL_MS = 2_500;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function CopyIcon({ type }: { type: SerializedWorkspaceDocument["documentType"] }) {
  if (type === "cell") return <FileSpreadsheet className="size-4 text-emerald-600" />;
  if (type === "pdf") return <FileType2 className="size-4 text-red-600" />;
  return <FileText className="size-4 text-blue-600" />;
}

/**
 * The kanban board's tenders, inside the Document Filler. Picking one lists
 * every file that tender published and every working copy the company has
 * already made of it, so a bid can be prepared without bouncing between
 * /kanban, the tender detail popup and this page.
 */
export function TenderWorkspaceBrowser() {
  const t = useTranslations("DocumentFiller.tenders");
  const tColumns = useTranslations("Workspace.kanban.columns");
  const format = useFormatter();

  const [tenders, setTenders] = useState<BoardTender[] | null>(null);
  const [selected, setSelected] = useState<BoardTender | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/tenders/pipeline", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { items: [] }))
      .then((json: { items?: BoardTender[] }) => setTenders(json.items ?? []))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  if (selected) {
    return (
      <TenderDocuments
        // Keyed by tender so picking another one remounts with fresh state
        // instead of resetting it from inside an effect.
        key={selected.tenderId}
        tender={selected}
        onBack={() => setSelected(null)}
        statusLabel={
          selected.status in STATUS_VARIANT
            ? tColumns(selected.status as "interested")
            : selected.status
        }
      />
    );
  }

  if (tenders === null) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-32 rounded-2xl" />
        ))}
      </div>
    );
  }

  if (tenders.length === 0) {
    return (
      <div className="grid place-items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-20 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
          <Inbox className="size-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-foreground">{t("empty.title")}</h2>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {t("empty.description")}
          </p>
        </div>
        <Button variant="outline" render={<Link href="/tenders" />}>
          <Search />
          {t("empty.action")}
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {tenders.map((tender) => (
        <article
          key={tender.tenderId}
          role="button"
          tabIndex={0}
          aria-label={t("openTenderDocuments", { title: tender.title ?? "" })}
          onClick={() => setSelected(tender)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              setSelected(tender);
            }
          }}
          className="flex cursor-pointer flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-xs transition-shadow hover:border-primary/30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
        >
          <Badge variant={STATUS_VARIANT[tender.status] ?? "neutral"}>
            {tender.status in STATUS_VARIANT
              ? tColumns(tender.status as "interested")
              : tender.status}
          </Badge>
          <h3 className="line-clamp-2 text-sm leading-snug font-semibold text-foreground">
            {tender.title ?? "—"}
          </h3>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Building2 className="size-3.5 shrink-0" />
            <span className="truncate">
              {[tender.buyerName, tender.buyerCity].filter(Boolean).join(" · ") || "—"}
            </span>
          </p>
          {tender.submissionDeadline && (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="size-3.5 shrink-0" />
              {format.dateTime(new Date(tender.submissionDeadline), {
                dateStyle: "medium",
              })}
            </p>
          )}
          <span className="mt-auto pt-1 text-xs font-semibold text-primary">
            {t("openDocuments")}
          </span>
        </article>
      ))}
    </div>
  );
}

function TenderDocuments({
  tender,
  onBack,
  statusLabel,
}: {
  tender: BoardTender;
  onBack: () => void;
  statusLabel: string;
}) {
  const t = useTranslations("DocumentFiller.tenders");
  const tLibrary = useTranslations("DocumentFiller.library");
  const format = useFormatter();
  const router = useRouter();

  const [files, setFiles] = useState<SerializedTenderFile[]>([]);
  const [copies, setCopies] = useState<SerializedWorkspaceDocument[]>([]);
  const [summary, setSummary] = useState<TenderDocumentFetchSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const tenderId = tender.tenderId;

  // Promise-chain rather than async/await so the setState calls sit inside
  // callbacks — an async body would make them synchronous effect work.
  const load = useCallback(
    (signal?: AbortSignal) =>
      Promise.all([
        fetch(`/api/tenders/${tenderId}/documents/status`, {
          signal,
          cache: "no-store",
        }).then((response) =>
          response.ok
            ? (response.json() as Promise<{
                summary: TenderDocumentFetchSummary;
                files: SerializedTenderFile[];
              }>)
            : null,
        ),
        fetch(`/api/workspace-documents?tenderId=${tenderId}&limit=100`, {
          signal,
          cache: "no-store",
        }).then((response) =>
          response.ok
            ? (response.json() as Promise<{ items?: SerializedWorkspaceDocument[] }>)
            : null,
        ),
      ]).then(([status, copyList]) => {
        if (status) {
          setSummary(status.summary);
          setFiles(status.files);
          if (status.summary.active) setActive(true);
        }
        if (copyList) setCopies(copyList.items ?? []);
      }),
    [tenderId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load]);

  // While a fetch runs, poll so files appear source by source rather than only
  // when the whole run ends — same cadence as the tender Documents tab.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      fetch(`/api/tenders/${tenderId}/documents/status`, {
        signal: controller.signal,
        cache: "no-store",
      })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<{
            summary: TenderDocumentFetchSummary;
            files: SerializedTenderFile[];
          }>;
        })
        .then((json) => {
          setSummary(json.summary);
          setFiles(json.files);
          if (json.summary.active) timer = setTimeout(tick, POLL_MS);
          else setActive(false);
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          setActive(false);
          setError(t("fetchError"));
        });
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, tenderId, t]);

  const startFetch = async () => {
    setBusy("fetch");
    setError("");
    try {
      const response = await fetch(`/api/tenders/${tenderId}/documents/fetch`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as {
        started: boolean;
        summary: TenderDocumentFetchSummary;
      };
      setSummary(json.summary);
      if (json.started) setActive(true);
    } catch {
      setError(t("fetchError"));
    } finally {
      setBusy("");
    }
  };

  const createWorkingCopy = async (file: SerializedTenderFile) => {
    const key = `${file.recordId}-${file.fileIndex}`;
    setBusy(key);
    setError("");
    try {
      const response = await fetch(`/api/tenders/${tenderId}/documents/working-copy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recordId: file.recordId, fileIndex: file.fileIndex }),
      });
      const body = (await response.json()) as {
        document?: SerializedWorkspaceDocument;
        error?: string;
      };
      if (!response.ok || !body.document) throw new Error(body.error || t("copyFailed"));
      if (body.document.state === "ready") {
        router.push(`/document-filler/${body.document.id}`);
        return;
      }
      // Still converting (legacy .doc/.xls) — show it in the copies list with
      // its state rather than opening an editor that cannot load yet.
      setCopies((current) => [body.document!, ...current]);
      setBusy("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("copyFailed"));
      setBusy("");
    }
  };

  const fetching = active || busy === "fetch";
  const done = summary ? summary.fetched + summary.skipped + summary.failed : 0;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft />
          {t("back")}
        </Button>
      </div>

      <header className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-xs sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_VARIANT[tender.status] ?? "neutral"}>{statusLabel}</Badge>
          {tender.submissionDeadline && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CalendarClock className="size-3.5" />
              {format.dateTime(new Date(tender.submissionDeadline), { dateStyle: "medium" })}
            </span>
          )}
        </div>
        <h2 className="text-base font-semibold text-foreground sm:text-lg">
          {tender.title ?? "—"}
        </h2>
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Building2 className="size-4 shrink-0" />
          <span className="truncate">
            {[tender.buyerName, tender.buyerCity].filter(Boolean).join(" · ") || "—"}
          </span>
        </p>
        <div className="pt-1">
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/tenders/${tenderId}`} />}
          >
            <ExternalLink />
            {t("openTender")}
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      ) : (
        <>
          {copies.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("workingCopies")}
              </h3>
              <ul className="flex flex-col gap-2">
                {copies.map((copy) => (
                  <li
                    key={copy.id}
                    className="flex items-center gap-3 rounded-xl border border-border bg-card p-3"
                  >
                    <CopyIcon type={copy.documentType} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      {copy.state === "ready" ? (
                        <Link
                          href={`/document-filler/${copy.id}`}
                          className="truncate text-sm font-semibold text-foreground hover:text-primary"
                        >
                          {copy.fileName}
                        </Link>
                      ) : (
                        <span className="truncate text-sm font-semibold text-muted-foreground">
                          {copy.fileName}
                        </span>
                      )}
                      <span className="text-[11px] text-muted-foreground">
                        {tLibrary("version", { n: copy.storageRevision })}
                      </span>
                    </span>
                    {copy.state === "converting" && (
                      <Badge variant="warning">
                        <Loader2 className="animate-spin" />
                        {tLibrary("state.converting")}
                      </Badge>
                    )}
                    {copy.state === "conversion_failed" && (
                      <Badge variant="danger">{tLibrary("state.conversionFailed")}</Badge>
                    )}
                    {copy.state === "ready" && (
                      <Button
                        size="sm"
                        variant="outline"
                        render={<Link href={`/document-filler/${copy.id}`} />}
                      >
                        <FilePenLine />
                        {t("continueEditing")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t("tenderFiles")}
              </h3>
              <Button variant="outline" size="sm" disabled={fetching} onClick={() => void startFetch()}>
                {fetching ? <Loader2 className="animate-spin" /> : <DownloadCloud />}
                {fetching
                  ? summary && active
                    ? t("fetchProgress", { done, total: summary.total })
                    : t("fetchRunning")
                  : files.length > 0
                    ? t("refetch")
                    : t("fetch")}
              </Button>
            </div>

            {files.length === 0 ? (
              <div className="grid place-items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
                <FileText className="size-6 text-muted-foreground" />
                <p className="max-w-sm text-sm text-muted-foreground">
                  {summary && done > 0 ? t("noFilesFound") : t("noFilesYet")}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {files.map((file) => {
                  const key = `${file.recordId}-${file.fileIndex}`;
                  return (
                    <li
                      key={key}
                      className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 transition-colors hover:border-primary/40"
                    >
                      <FileText className="size-4 shrink-0 text-primary/70" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm text-foreground">{file.fileName}</span>
                        <span className="truncate text-[11px] text-muted-foreground">
                          {formatBytes(file.byteLength)} · {file.mimeType}
                        </span>
                      </span>
                      {workspaceFormat(file.fileName) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy === key}
                          onClick={() => void createWorkingCopy(file)}
                        >
                          {busy === key ? <Loader2 className="animate-spin" /> : <FilePenLine />}
                          {t("editCopy")}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t("download")}
                        aria-label={t("download")}
                        render={
                          <a
                            href={`/api/tenders/${tenderId}/documents?record=${encodeURIComponent(file.recordId)}&file=${file.fileIndex}`}
                          />
                        }
                      >
                        <Download />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
