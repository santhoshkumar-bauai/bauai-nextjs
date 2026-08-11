"use client";

import type { Config } from "@onlyoffice/doceditor-types";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

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
    return () => {
      controller.abort();
      window.DocEditor?.instances?.[editorId]?.destroyEditor();
    };
  }, [documentId, editorId, t]);

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
