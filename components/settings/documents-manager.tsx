"use client";

import { Download, FileText, Loader2, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState } from "react";

import { card, formatDate } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import type { SerializedCompanyFile } from "@/lib/company/serialize";
import {
  deleteCompanyFile,
  getCompanyFileUrl,
  uploadCompanyFiles,
} from "@/lib/company/upload-client";
import {
  DOCUMENT_ACCEPT_ATTRIBUTE,
  MAX_UPLOAD_BYTES,
  validateCompanyUpload,
  type UploadRejection,
} from "@/lib/company/upload-limits";
import { DOCUMENT_CATEGORIES } from "@/lib/company/settings-sections";
import type { CompanyFileCategory } from "@/models/company-file";

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** A file the user picked, tracked until it lands (or fails) server-side. */
type QueueItem = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "error";
  error?: string;
};

let queueIdCounter = 0;
const nextQueueId = () => `q${++queueIdCounter}`;

/** Upload / list / view / delete company documents via the presigned-URL flow. */
export function DocumentsManager({
  initialFiles,
  canEdit,
}: {
  initialFiles: SerializedCompanyFile[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const t = useTranslations("Settings");
  const [files, setFiles] = useState<SerializedCompanyFile[]>(initialFiles);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  return (
    <div className="grid gap-[18px]">
      {error && (
        <p className="text-[11px] font-semibold text-[#c02626]">{error}</p>
      )}
      {DOCUMENT_CATEGORIES.map((key) => (
        <CategoryCard
          key={key}
          categoryKey={key}
          label={t(`documents.categories.${key}.label`)}
          description={t(`documents.categories.${key}.description`)}
          files={files.filter((file) => file.category === key)}
          canEdit={canEdit}
          busy={busy}
          onUploaded={(uploaded) => setFiles((prev) => [uploaded, ...prev])}
          onBatchSettled={() => router.refresh()}
          onView={async (id) => {
            setBusy(`view:${id}`);
            try {
              const url = await getCompanyFileUrl(id);
              window.open(url, "_blank", "noopener,noreferrer");
            } catch (viewError) {
              setError(
                viewError instanceof Error
                  ? viewError.message
                  : t("feedback.openFailed"),
              );
            } finally {
              setBusy(null);
            }
          }}
          onDelete={async (id) => {
            setBusy(`delete:${id}`);
            setError("");
            try {
              await deleteCompanyFile(id);
              setFiles((prev) => prev.filter((file) => file.id !== id));
              router.refresh();
            } catch (deleteError) {
              setError(
                deleteError instanceof Error
                  ? deleteError.message
                  : t("feedback.deleteFailed"),
              );
            } finally {
              setBusy(null);
            }
          }}
        />
      ))}
    </div>
  );
}

function CategoryCard({
  categoryKey,
  label,
  description,
  files,
  canEdit,
  busy,
  onUploaded,
  onBatchSettled,
  onView,
  onDelete,
}: {
  categoryKey: CompanyFileCategory;
  label: string;
  description: string;
  files: SerializedCompanyFile[];
  canEdit: boolean;
  busy: string | null;
  onUploaded: (file: SerializedCompanyFile) => void;
  onBatchSettled: () => void;
  onView: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useTranslations("Settings");
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const uploading = queue.some((item) => item.status !== "error");

  const rejectionMessage = useCallback(
    (reason: UploadRejection, fileName: string) =>
      reason === "size"
        ? t("feedback.fileTooLarge", {
            name: fileName,
            limit: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)),
          })
        : reason === "empty"
          ? t("feedback.emptyFile", { name: fileName })
          : t("feedback.unsupportedFileType", { name: fileName }),
    [t],
  );

  /** Validate locally, show every picked file, then upload the valid ones. */
  const enqueue = useCallback(
    async (picked: File[]) => {
      if (!canEdit || picked.length === 0) return;

      const items: QueueItem[] = picked.map((file) => {
        const rejection = validateCompanyUpload(file, categoryKey);
        return rejection
          ? {
              id: nextQueueId(),
              file,
              status: "error" as const,
              error: rejectionMessage(rejection, file.name),
            }
          : { id: nextQueueId(), file, status: "queued" as const };
      });
      setQueue((prev) => [...prev, ...items]);

      const uploadable = items.filter((item) => item.status === "queued");
      if (uploadable.length === 0) return;

      await uploadCompanyFiles(
        uploadable.map((item) => item.file),
        categoryKey,
        {
          onStart: (index) =>
            setQueue((prev) =>
              prev.map((item) =>
                item.id === uploadable[index].id
                  ? { ...item, status: "uploading" }
                  : item,
              ),
            ),
          onOutcome: (outcome) => {
            const id = uploadable[outcome.index].id;
            if (outcome.status === "done") {
              // Logo uploads never reach this card, so the file is always present.
              if (outcome.result.category !== "logo") onUploaded(outcome.result.file);
              setQueue((prev) => prev.filter((item) => item.id !== id));
              return;
            }
            setQueue((prev) =>
              prev.map((item) =>
                item.id === id
                  ? { ...item, status: "error", error: outcome.error }
                  : item,
              ),
            );
          },
        },
      );
      onBatchSettled();
    },
    [canEdit, categoryKey, onBatchSettled, onUploaded, rejectionMessage],
  );

  const retry = useCallback(
    (item: QueueItem) => {
      setQueue((prev) => prev.filter((queued) => queued.id !== item.id));
      void enqueue([item.file]);
    },
    [enqueue],
  );

  return (
    <section
      className={`${card} p-5 transition-colors sm:p-6 ${
        dragging ? "border-[#7c5cff] bg-[#f8f6ff]" : ""
      }`}
      onDragOver={
        canEdit
          ? (event) => {
              event.preventDefault();
              setDragging(true);
            }
          : undefined
      }
      onDragLeave={canEdit ? () => setDragging(false) : undefined}
      onDrop={
        canEdit
          ? (event) => {
              event.preventDefault();
              setDragging(false);
              void enqueue(Array.from(event.dataTransfer.files));
            }
          : undefined
      }
    >
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-sm font-bold">{label}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-[#85818c]">
            {description}
          </p>
          {canEdit && (
            <p className="mt-1 text-[11px] text-[#a29eaa]">
              {t("documents.multipleHint")}
            </p>
          )}
        </div>
        {canEdit && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={DOCUMENT_ACCEPT_ATTRIBUTE}
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                event.target.value = "";
                void enqueue(picked);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? <Loader2 className="animate-spin" size={14} /> : <Upload size={14} />}
              {t("actions.upload")}
            </Button>
          </>
        )}
      </header>
      {queue.length > 0 && (
        <ul className="mt-4 grid gap-2">
          {queue.map((item) => (
            <li
              key={item.id}
              className={`flex items-center gap-3 rounded-[10px] border px-3 py-2.5 ${
                item.status === "error"
                  ? "border-[#f3d5d5] bg-[#fdf7f7]"
                  : "border-[#eee9f3]"
              }`}
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#f5f5f8] text-[#6b6872]">
                {item.status === "error" ? (
                  <X size={16} className="text-[#c02626]" />
                ) : (
                  <Loader2
                    size={16}
                    className={item.status === "uploading" ? "animate-spin" : "opacity-40"}
                  />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-xs text-[#26232a]">
                  {item.file.name}
                </strong>
                <span
                  className={`block truncate text-[10px] ${
                    item.status === "error" ? "text-[#c02626]" : "text-[#8d8993]"
                  }`}
                >
                  {item.status === "error"
                    ? item.error
                    : item.status === "uploading"
                      ? t("documents.uploadingFile")
                      : t("documents.queued")}
                </span>
              </div>
              {item.status === "error" && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title={t("actions.retry")}
                    onClick={() => retry(item)}
                  >
                    <RotateCcw size={14} />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    title={t("actions.dismiss")}
                    onClick={() =>
                      setQueue((prev) => prev.filter((queued) => queued.id !== item.id))
                    }
                  >
                    <X size={14} />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 ? (
        <ul className="mt-4 grid gap-2">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-3 rounded-[10px] border border-[#eee9f3] px-3 py-2.5"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[#f5f5f8] text-[#6b6872]">
                <FileText size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <strong className="block truncate text-xs text-[#26232a]">
                  {file.fileName}
                </strong>
                <span className="text-[10px] text-[#8d8993]">
                  {formatBytes(file.size)}
                  {file.createdAt ? ` · ${formatDate(file.createdAt)}` : ""}
                </span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={t("actions.view")}
                disabled={busy === `view:${file.id}`}
                onClick={() => onView(file.id)}
              >
                {busy === `view:${file.id}` ? (
                  <Loader2 className="animate-spin" size={14} />
                ) : (
                  <Download size={14} />
                )}
              </Button>
              {canEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  title={t("actions.delete")}
                  disabled={busy === `delete:${file.id}`}
                  onClick={() => onDelete(file.id)}
                  className="text-[#c02626] hover:bg-[#fdeaea]"
                >
                  {busy === `delete:${file.id}` ? (
                    <Loader2 className="animate-spin" size={14} />
                  ) : (
                    <Trash2 size={14} />
                  )}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        queue.length === 0 && (
          <p className="mt-4 text-xs text-[#a29eaa]">{t("documents.empty")}</p>
        )
      )}
    </section>
  );
}
