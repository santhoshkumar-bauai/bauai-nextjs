"use client";

import type { Config } from "@onlyoffice/doceditor-types";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { generatedDocumentIdFromEditorMessage } from "@/lib/onlyoffice/editor-messages";

const DocumentEditor = dynamic(
  () => import("@onlyoffice/document-editor-react").then((module) => module.DocumentEditor),
  { ssr: false },
);

type EditorPayload = { documentServerUrl: string; config: Config };

export function OnlyOfficeEditorClient({
  documentId,
  onStateChange,
}: {
  documentId: string;
  onStateChange?: (state: string) => void;
}) {
  const t = useTranslations("DocumentFiller.editor");
  const router = useRouter();
  const [payload, setPayload] = useState<EditorPayload | null>(null);
  const [error, setError] = useState("");
  const editorId = useMemo(() => `onlyoffice-${documentId}`, [documentId]);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/onlyoffice/config/${documentId}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = (await response.json()) as EditorPayload & { error?: string };
        if (!response.ok) throw new Error(body.error || t("configError"));
        setPayload(body);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : t("configError"));
        }
      });
    return () => controller.abort();
  }, [documentId, editorId, t]);

  /**
   * The editor's lifetime belongs to the DOCUMENT, not to this fetch.
   *
   * Destroying it from the config effect above looked equivalent but was not:
   * that effect depends on `t`, whose identity changes on re-render and on
   * every Fast Refresh. A single unrelated re-render therefore tore down a
   * live editor, and the ONLYOFFICE React wrapper refuses to build a second
   * one for the same placeholder ("Skip loading. Instance already exists") —
   * leaving the page on its skeleton with no error anywhere.
   *
   * destroyEditor() also leaves its own registry entry behind, so clear it
   * explicitly or the next legitimate mount hits the same guard.
   */
  useEffect(() => {
    return () => {
      const instances = window.DocEditor?.instances;
      try {
        instances?.[editorId]?.destroyEditor();
      } catch {
        // Already torn down by the wrapper; the delete below is what matters.
      }
      if (instances) delete instances[editorId];
    };
  }, [editorId]);

  useEffect(() => {
    if (!payload) return;

    const editorOrigin = new URL(payload.documentServerUrl, window.location.href).origin;
    const onMessage = (event: MessageEvent) => {
      const editorFrame = document.querySelector<HTMLIFrameElement>('iframe[name="frameEditor"]');
      if (event.origin !== editorOrigin || event.source !== editorFrame?.contentWindow) return;

      const generatedDocumentId = generatedDocumentIdFromEditorMessage(event.data);
      if (generatedDocumentId) router.push(`/document-filler/${generatedDocumentId}`);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [payload, router]);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-muted/40 p-8">
        <div className="max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-xs">
          <AlertTriangle className="mx-auto mb-3 size-6 text-destructive" />
          <h2 className="font-semibold text-foreground">{t("openError")}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <Button variant="outline" className="mt-4" onClick={() => location.reload()}>
            {t("retry")}
          </Button>
        </div>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="grid h-full place-items-center bg-muted/40 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Loader2 className="animate-spin" /> {t("loadingEditor")}
        </span>
      </div>
    );
  }

  return (
    <DocumentEditor
      key={`${documentId}-${payload.config.document?.key}`}
      id={editorId}
      documentServerUrl={payload.documentServerUrl}
      config={payload.config}
      width="100%"
      height="100%"
      onLoadComponentError={(code, description) => {
        const known: Record<number, string> = {
          [-1]: t("loadError.script"),
          [-2]: t("loadError.init"),
          [-3]: t("loadError.unsupported"),
        };
        setError(known[code] || description);
      }}
      events_onDocumentReady={() => onStateChange?.("ready")}
      events_onDocumentStateChange={(event) => {
        const changed = (event as { data?: boolean }).data;
        onStateChange?.(changed ? "editing" : "saved");
      }}
      events_onWarning={(event) => console.warn("ONLYOFFICE warning", event)}
      events_onError={(event) => {
        console.error("ONLYOFFICE error", event);
        onStateChange?.("error");
      }}
    />
  );
}
