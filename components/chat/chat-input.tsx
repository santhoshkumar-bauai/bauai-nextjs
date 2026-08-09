"use client";

import { FileText, Image as ImageIcon, Loader2, Paperclip, Send, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { ChatDensity } from "./message-list";
import type { PendingAttachment } from "./use-clara-chat";

const MAX_FILES = 4;

interface UploadingFile {
  key: string;
  fileName: string;
}

export function ChatInput({
  onSend,
  onStop,
  sending,
  disabled,
  density = "compact",
  placeholder,
}: {
  onSend: (text: string, attachments?: PendingAttachment[]) => void;
  onStop: () => void;
  sending: boolean;
  disabled?: boolean;
  density?: ChatDensity;
  placeholder?: string;
}) {
  const t = useTranslations("Chat");
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState<UploadingFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  // Enter pressed while a file is still uploading: queue, send when ready.
  const [queuedSubmit, setQueuedSubmit] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const comfortable = density === "comfortable";

  const uploadFiles = (files: FileList | null) => {
    if (!files) return;
    setUploadError(null);
    const room = MAX_FILES - attachments.length - uploading.length;
    for (const file of Array.from(files).slice(0, Math.max(0, room))) {
      const key = `${file.name}-${Date.now()}-${Math.random()}`;
      setUploading((prev) => [...prev, { key, fileName: file.name }]);
      const form = new FormData();
      form.append("file", file);
      void fetch("/api/chat/attachments", { method: "POST", body: form })
        .then(async (response) => {
          if (!response.ok) {
            setUploadError(response.status === 413 ? "too_large" : "failed");
            return;
          }
          const json = (await response.json()) as {
            attachment: PendingAttachment;
          };
          setAttachments((prev) =>
            prev.length < MAX_FILES ? [...prev, json.attachment] : prev,
          );
        })
        .catch(() => setUploadError("failed"))
        .finally(() =>
          setUploading((prev) => prev.filter((upload) => upload.key !== key)),
        );
    }
  };

  const submit = () => {
    const trimmed = text.trim();
    if (sending) return;
    if (uploading.length > 0) {
      // Don't swallow the keystroke — deliver as soon as uploads finish.
      setQueuedSubmit(true);
      return;
    }
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, attachments.length > 0 ? attachments : undefined);
    setText("");
    setAttachments([]);
    setUploadError(null);
  };

  useEffect(() => {
    if (!queuedSubmit || uploading.length > 0) return;
    // Deferred so setState runs outside the effect body (repo lint pattern).
    const timer = setTimeout(() => {
      setQueuedSubmit(false);
      submit();
    }, 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit closes over current text/attachments by design
  }, [queuedSubmit, uploading.length]);

  const canSubmit =
    !disabled &&
    !sending &&
    uploading.length === 0 &&
    (text.trim().length > 0 || attachments.length > 0);

  return (
    <div className={cn("border-t border-border", comfortable ? "px-4 py-3" : "px-3 py-2.5")}>
      {(attachments.length > 0 || uploading.length > 0 || uploadError) && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {attachments.map((attachment) => (
            <span
              key={attachment.id}
              className={cn(
                "flex items-center gap-1.5 rounded-full border border-border bg-muted/50 py-1 pr-1 pl-2.5 text-[11px] text-foreground",
                attachment.status !== "ready" && "opacity-60",
              )}
              title={
                attachment.status === "ready"
                  ? attachment.fileName
                  : `${attachment.fileName} — ${t("attach.unsupported")}`
              }
            >
              {attachment.contentType.startsWith("image/") ? (
                <ImageIcon className="size-3 text-muted-foreground" />
              ) : (
                <FileText className="size-3 text-muted-foreground" />
              )}
              <span className="max-w-40 truncate">{attachment.fileName}</span>
              <button
                type="button"
                aria-label={t("attach.remove")}
                onClick={() =>
                  setAttachments((prev) =>
                    prev.filter((entry) => entry.id !== attachment.id),
                  )
                }
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {uploading.map((upload) => (
            <span
              key={upload.key}
              className="flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" />
              <span className="max-w-40 truncate">{upload.fileName}</span>
            </span>
          ))}
          {uploadError && (
            <span className="text-[11px] text-rose-600">
              {uploadError === "too_large" ? t("attach.tooLarge") : t("attach.failed")}
            </span>
          )}
        </div>
      )}

      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            uploadFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          aria-label={t("attach.button")}
          title={t("attach.button")}
          disabled={disabled || attachments.length + uploading.length >= MAX_FILES}
          onClick={() => fileInputRef.current?.click()}
          className={cn(
            "grid shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:bg-muted disabled:opacity-50",
            comfortable ? "size-11" : "size-9",
          )}
        >
          <Paperclip className={comfortable ? "size-4" : "size-3.5"} />
        </button>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder ?? t("placeholder")}
          rows={1}
          maxLength={4000}
          disabled={disabled}
          className={cn(
            "flex-1 resize-none rounded-lg border border-border bg-background outline-none focus:border-ring disabled:opacity-50",
            comfortable
              ? "max-h-40 min-h-11 px-3.5 py-2.5 text-sm"
              : "max-h-24 min-h-9 px-2.5 py-2 text-xs",
          )}
        />
        {sending ? (
          <button
            type="button"
            onClick={onStop}
            aria-label={t("stop")}
            className={cn(
              "grid shrink-0 place-items-center rounded-lg border border-border text-muted-foreground hover:bg-muted",
              comfortable ? "size-11" : "size-9",
            )}
          >
            <Square className={comfortable ? "size-4" : "size-3.5"} />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit && uploading.length === 0}
            aria-label={t("send")}
            className={cn(
              "grid shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50",
              comfortable ? "size-11" : "size-9",
            )}
          >
            {uploading.length > 0 ? (
              <Loader2 className={cn("animate-spin", comfortable ? "size-4" : "size-3.5")} />
            ) : (
              <Send className={comfortable ? "size-4" : "size-3.5"} />
            )}
          </button>
        )}
      </div>
    </div>
  );
}
