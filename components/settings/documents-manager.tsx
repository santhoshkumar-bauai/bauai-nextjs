"use client";

import { Download, FileText, Loader2, Trash2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { card, formatDate } from "@/components/settings/settings-ui";
import { Button } from "@/components/ui/button";
import type { SerializedCompanyFile } from "@/lib/company/serialize";
import {
  deleteCompanyFile,
  getCompanyFileUrl,
  uploadCompanyFile,
} from "@/lib/company/upload-client";
import { DOCUMENT_CATEGORIES } from "@/lib/company/settings-sections";
import type { CompanyFileCategory } from "@/models/company-file";

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

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

  const update = (mutate: (prev: SerializedCompanyFile[]) => SerializedCompanyFile[]) =>
    setFiles((prev) => mutate(prev));

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
          onUpload={async (file) => {
            setBusy(`upload:${key}`);
            setError("");
            try {
              const result = await uploadCompanyFile(file, key);
              if (result.category !== "logo") {
                update((prev) => [result.file, ...prev]);
              }
              router.refresh();
            } catch (uploadError) {
              setError(
                uploadError instanceof Error
                  ? uploadError.message
                  : t("feedback.uploadFailed"),
              );
            } finally {
              setBusy(null);
            }
          }}
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
              update((prev) => prev.filter((file) => file.id !== id));
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
  onUpload,
  onView,
  onDelete,
}: {
  categoryKey: CompanyFileCategory;
  label: string;
  description: string;
  files: SerializedCompanyFile[];
  canEdit: boolean;
  busy: string | null;
  onUpload: (file: File) => void;
  onView: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const t = useTranslations("Settings");
  const inputRef = useRef<HTMLInputElement>(null);
  const uploading = busy === `upload:${categoryKey}`;

  return (
    <section className={`${card} p-5 sm:p-6`}>
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="m-0 text-sm font-bold">{label}</h2>
          <p className="mt-0.5 text-xs leading-relaxed text-[#85818c]">
            {description}
          </p>
        </div>
        {canEdit && (
          <>
            <input
              ref={inputRef}
              type="file"
              accept="application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) onUpload(file);
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
        <p className="mt-4 text-xs text-[#a29eaa]">{t("documents.empty")}</p>
      )}
    </section>
  );
}
