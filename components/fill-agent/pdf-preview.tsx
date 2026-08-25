"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Page-image preview strip: the sidecar's renders (source + filled), proxied
 * through the artifacts route. No PDF.js — the renders already exist and are
 * exactly what the validator judged. Clicking a page opens it full-size in a
 * lightbox. `refreshKey` cache-busts after each turn so a new fill run
 * replaces the images.
 */
export function PdfPreview({
  sessionId,
  pageCount,
  hasOutput,
  refreshKey,
}: {
  sessionId: string;
  pageCount: number;
  hasOutput: boolean;
  refreshKey: number;
}) {
  const t = useTranslations("FillAgent");
  const [tab, setTab] = useState<"source" | "filled">(hasOutput ? "filled" : "source");
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null);
  const dir = tab === "filled" ? "output_pages" : "source_pages";

  // The filled tab becomes available mid-session; follow it once output
  // exists (adjust-state-during-render pattern, not an effect).
  const [prevHasOutput, setPrevHasOutput] = useState(hasOutput);
  if (hasOutput !== prevHasOutput) {
    setPrevHasOutput(hasOutput);
    if (hasOutput) setTab("filled");
  }

  const close = useCallback(() => setLightbox(null), []);
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, close]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 pb-2">
        {(["source", "filled"] as const).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-lg px-2.5 py-1 text-[11px] font-medium ${
              tab === key
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {key === "source" ? t("previewSource") : t("previewFilled")}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {tab === "filled" && !hasOutput ? (
          <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[11px] text-muted-foreground">
            {t("previewFilledEmpty")}
          </p>
        ) : (
          Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => (
            <PageImage
              key={`${dir}-${page}-${refreshKey}`}
              src={`/api/poc/fill-chat/${sessionId}/artifacts/${dir}/page_${page}.png?v=${refreshKey}`}
              label={t("page", { page })}
              emptyText={t("previewEmpty")}
              showEmptyText={page === 1}
              onOpen={(src, label) => setLightbox({ src, label })}
            />
          ))
        )}
      </div>

      {lightbox && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={lightbox.label}
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-6"
          onClick={close}
        >
          <div
            className="relative w-full max-w-3xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-xl bg-background/95 px-3 py-2">
              <span className="text-xs font-medium text-foreground">
                {lightbox.label}
              </span>
              <button
                type="button"
                onClick={close}
                aria-label={t("lightboxClose")}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element -- sandbox proxy, not an optimizable asset */}
            <img
              src={lightbox.src}
              alt={lightbox.label}
              className="w-full rounded-b-xl bg-white"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function PageImage({
  src,
  label,
  emptyText,
  showEmptyText,
  onOpen,
}: {
  src: string;
  label: string;
  emptyText: string;
  showEmptyText: boolean;
  onOpen: (src: string, label: string) => void;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return showEmptyText ? (
      <p className="rounded-xl border border-dashed border-border px-3 py-2.5 text-[11px] text-muted-foreground">
        {emptyText}
      </p>
    ) : null;
  }
  return (
    <figure>
      <figcaption className="pb-1 text-[10px] text-muted-foreground">{label}</figcaption>
      <button
        type="button"
        onClick={() => onOpen(src, label)}
        className="block w-full cursor-zoom-in"
        title={label}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- sandbox proxy, not an optimizable asset */}
        <img
          src={src}
          alt={label}
          onError={() => setFailed(true)}
          className="w-full rounded-lg border border-border bg-white shadow-sm transition-shadow hover:shadow-md"
        />
      </button>
    </figure>
  );
}
