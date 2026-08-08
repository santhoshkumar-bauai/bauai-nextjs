"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Serialized extraction record as returned by GET /extractions. */
export interface ExtractionRecordView {
  schemaName: string;
  schemaVersion: number;
  status: "VERIFIED" | "PARTIAL" | "EMPTY" | "FAILED";
  fields: FieldsMap;
  unresolved: string[];
  sourceDocumentRecordIds: string[];
  stats: {
    modelCalls: number;
    retriedFields: number;
    verifiedFields: number;
    totalFields: number;
  };
  corpusHash: string;
  extractedAt: string;
}

export interface StoredCitedValueView {
  value: unknown;
  confidence: number;
  citations: Array<{
    quote: string;
    chunkId: string | null;
    documentRecordId: string | null;
  }>;
  citationState: "VERIFIED" | "UNVERIFIED" | "MISSING";
}

type FieldsMap = { [field: string]: StoredCitedValueView };

export type SchemaRunState =
  | "NOT_STARTED"
  | "PENDING"
  | "RUNNING"
  | "DONE"
  | "FAILED";

export interface ExtractionsState {
  records: ExtractionRecordView[];
  runStates: { [schema: string]: SchemaRunState };
  corpusReady: boolean | null;
  analyzing: boolean;
  error: string | null;
}

const POLL_MS = 3500;
const POLL_TIMEOUT_MS = 4 * 60_000;

/**
 * Owns the extraction lifecycle for one tender: initial load of stored
 * records, the analyze trigger, and status polling while the worker runs.
 * Everything aborts cleanly when the tender changes or the dialog closes.
 */
export function useExtractions(tenderId: string | null): ExtractionsState & {
  analyze: () => void;
} {
  const [records, setRecords] = useState<ExtractionRecordView[]>([]);
  const [runStates, setRunStates] = useState<{ [schema: string]: SchemaRunState }>({});
  const [corpusReady, setCorpusReady] = useState<boolean | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  const loadOnce = useCallback(
    async (id: string, signal: AbortSignal) => {
      const [extractionsRes, statusRes] = await Promise.all([
        fetch(`/api/tenders/${id}/extractions`, { signal }),
        fetch(`/api/tenders/${id}/extract/status`, { signal }),
      ]);
      if (extractionsRes.ok) {
        const json = (await extractionsRes.json()) as {
          extractions: ExtractionRecordView[];
        };
        setRecords(json.extractions);
      }
      if (statusRes.ok) {
        const json = (await statusRes.json()) as {
          corpusReady: boolean;
          schemas: { [schema: string]: { status: SchemaRunState } };
        };
        setCorpusReady(json.corpusReady);
        setRunStates(
          Object.fromEntries(
            Object.entries(json.schemas).map(([name, s]) => [name, s.status]),
          ),
        );
        return json;
      }
      return null;
    },
    [],
  );

  useEffect(() => {
    stopPolling();
    const controller = new AbortController();
    // Deferred reset avoids synchronous setState inside the effect body
    // (mirrors the detail-fetch pattern in tender-detail-dialog.tsx).
    const timer = setTimeout(() => {
      setRecords([]);
      setRunStates({});
      setCorpusReady(null);
      setAnalyzing(false);
      setError(null);
      if (!tenderId) return;
      loadOnce(tenderId, controller.signal).catch(() => undefined);
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
      stopPolling();
    };
  }, [tenderId, loadOnce, stopPolling]);

  const analyze = useCallback(() => {
    if (!tenderId || analyzing) return;
    setAnalyzing(true);
    setError(null);
    const controller = new AbortController();
    const startedAt = Date.now();

    void (async () => {
      try {
        const response = await fetch(`/api/tenders/${tenderId}/extract`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (response.status === 409) {
          setCorpusReady(false);
          setAnalyzing(false);
          return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        pollTimer.current = setInterval(() => {
          void (async () => {
            if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
              stopPolling();
              setAnalyzing(false);
              setError("timeout");
              return;
            }
            const status = await loadOnce(tenderId, controller.signal);
            if (!status) return;
            const states = Object.values(status.schemas).map((s) => s.status);
            const pending = states.filter(
              (s) => s === "PENDING" || s === "RUNNING" || s === "NOT_STARTED",
            );
            if (pending.length === 0) {
              stopPolling();
              setAnalyzing(false);
            }
          })();
        }, POLL_MS);
      } catch {
        setAnalyzing(false);
        setError("request");
      }
    })();
  }, [tenderId, analyzing, loadOnce, stopPolling]);

  return { records, runStates, corpusReady, analyzing, error, analyze };
}
