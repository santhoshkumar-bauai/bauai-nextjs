"use client";

import { useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

/** Direct multipart upload to the sessions route; parent gets the new id. */
export function UploadDropzone({
  maxPages,
  onCreated,
}: {
  maxPages: number;
  onCreated: (sessionId: string) => void;
}) {
  const t = useTranslations("FillAgent");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const errorText = (code: string): string => {
    switch (code) {
      case "scanned_pdf":
        return t("errorScanned");
      case "file_too_large":
        return t("errorTooLarge");
      case "too_many_pages":
        return t("errorTooManyPages");
      case "not_a_pdf":
        return t("errorNotPdf");
      case "pdf_encrypted":
        return t("errorEncrypted");
      default:
        return t("errorGeneric");
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/poc/fill-chat/sessions", {
        method: "POST",
        body: form,
      });
      const json = (await response.json().catch(() => null)) as
        | { session?: { id: string }; error?: string }
        | null;
      if (!response.ok || !json?.session) {
        setError(t("uploadFailed", { reason: errorText(json?.error ?? "unknown") }));
        return;
      }
      onCreated(json.session.id);
    } catch {
      setError(t("uploadFailed", { reason: t("errorGeneric") }));
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files?.[0];
          if (file) void upload(file);
        }}
        className={`flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
        } disabled:opacity-60`}
      >
        <span className="flex size-6 items-center justify-center">
          {uploading ? (
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          ) : (
            <FileUp className="size-6 text-muted-foreground" />
          )}
        </span>
        <span className="text-sm font-medium text-foreground">
          {uploading ? t("uploading") : t("dropzoneTitle")}
        </span>
        <span className="text-xs text-muted-foreground">
          {t("dropzoneHint", { maxPages })}
        </span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      {error && <p className="pt-2 text-xs text-rose-600">{error}</p>}
    </div>
  );
}
