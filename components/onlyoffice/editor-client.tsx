"use client";

import type { Config } from "@onlyoffice/doceditor-types";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";

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
        if (!response.ok) throw new Error(body.error || "Unable to configure the editor.");
        setPayload(body);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Unable to configure the editor.");
        }
      });
    return () => {
      controller.abort();
      window.DocEditor?.instances?.[editorId]?.destroyEditor();
    };
  }, [documentId, editorId]);

  if (error) {
    return (
      <div className="grid h-full place-items-center bg-[#f7f7fa] p-8">
        <div className="max-w-md rounded-2xl border border-red-200 bg-white p-6 text-center shadow-sm">
          <AlertTriangle className="mx-auto mb-3 text-red-600" />
          <h2 className="font-semibold">The editor could not be opened</h2>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <button className="mt-4 text-sm font-semibold text-primary" onClick={() => location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  }
  if (!payload) {
    return (
      <div className="grid h-full place-items-center bg-[#f7f7fa] text-sm text-muted-foreground">
        <span className="flex items-center gap-2"><Loader2 className="animate-spin" /> Loading editor…</span>
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
          [-1]: "The ONLYOFFICE API script could not be loaded.",
          [-2]: "The ONLYOFFICE editor could not be initialized.",
          [-3]: "The ONLYOFFICE editor is not supported by this browser.",
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
