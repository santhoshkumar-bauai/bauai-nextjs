"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WireChatMessage, WireVerdict } from "@/lib/ai/agent/wire";
import { SseFrameParser } from "./sse";

export interface DoraChatState {
  messages: WireChatMessage[];
  /** Assistant text currently streaming (not yet a persisted message). */
  streamingText: string;
  /** Tool currently running, for the status line. */
  activeTool: string | null;
  sending: boolean;
  loading: boolean;
  error: string | null;
  verdicts: Record<string, WireVerdict>;
}

/** Chat lifecycle for one tender: bootstrap, send-with-SSE, abort, clear. */
export function useDoraChat(tenderId: string | null) {
  const [state, setState] = useState<DoraChatState>({
    messages: [],
    streamingText: "",
    activeTool: null,
    sending: false,
    loading: false,
    error: null,
    verdicts: {},
  });
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState({
        messages: [],
        streamingText: "",
        activeTool: null,
        sending: false,
        loading: Boolean(tenderId),
        error: null,
        verdicts: {},
      });
      if (!tenderId) return;
      fetch(`/api/tenders/${tenderId}/chat`, { signal: controller.signal })
        .then((response) => (response.ok ? response.json() : null))
        .then(
          (json: { messages: WireChatMessage[]; verdicts?: WireVerdict[] } | null) => {
            if (!json) return;
            setState((prev) => ({
              ...prev,
              messages: json.messages,
              loading: false,
              verdicts: Object.fromEntries(
                (json.verdicts ?? []).map((verdict) => [verdict.id, verdict]),
              ),
            }));
          },
        )
        .catch(() => undefined)
        .finally(() =>
          setState((prev) => (prev.loading ? { ...prev, loading: false } : prev)),
        );
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [tenderId]);

  const post = useCallback(
    (body: { message: string } | { command: "verdict" }, optimisticText: string | null) => {
      if (!tenderId) return;
      const controller = new AbortController();
      abortRef.current = controller;

      setState((prev) => ({
        ...prev,
        messages: optimisticText
          ? [
              ...prev.messages,
              {
                id: `optimistic-${Date.now()}`,
                role: "user",
                content: optimisticText,
                status: "complete",
                locale: "en",
                toolEvents: [],
                citations: [],
                verdictId: null,
                createdAt: new Date().toISOString(),
              },
            ]
          : prev.messages,
        streamingText: "",
        activeTool: "command" in body ? "verdict" : null,
        sending: true,
        error: null,
      }));

      void (async () => {
        try {
          const response = await fetch(`/api/tenders/${tenderId}/chat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            const data = (await response.json().catch(() => ({}))) as {
              error?: string;
            };
            throw new Error(data.error || "failed");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const parser = new SseFrameParser();

          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            for (const event of parser.push(decoder.decode(value, { stream: true }))) {
              setState((prev) => {
                switch (event.type) {
                  case "token":
                    return {
                      ...prev,
                      streamingText: prev.streamingText + event.delta,
                      activeTool: null,
                    };
                  case "tool":
                    return {
                      ...prev,
                      activeTool: event.status === "start" ? event.name : null,
                    };
                  case "artifact":
                    return {
                      ...prev,
                      verdicts: { ...prev.verdicts, [event.verdict.id]: event.verdict },
                    };
                  case "message":
                    return {
                      ...prev,
                      messages: [...prev.messages, event.message],
                      streamingText: "",
                      activeTool: null,
                    };
                  case "error":
                    return { ...prev, error: event.message };
                  default:
                    return prev;
                }
              });
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            setState((prev) => ({ ...prev, error: String((error as Error).message) }));
          }
        } finally {
          setState((prev) => ({
            ...prev,
            sending: false,
            activeTool: null,
            streamingText: "",
          }));
          abortRef.current = null;
        }
      })();
    },
    [tenderId],
  );

  const send = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      post({ message: text }, text);
    },
    [post],
  );

  const requestVerdict = useCallback(() => {
    post({ command: "verdict" }, null);
  }, [post]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    if (!tenderId) return;
    void fetch(`/api/tenders/${tenderId}/chat`, { method: "DELETE" }).then(() =>
      setState((prev) => ({ ...prev, messages: [], verdicts: {}, error: null })),
    );
  }, [tenderId]);

  return { ...state, send, requestVerdict, stop, clear };
}
