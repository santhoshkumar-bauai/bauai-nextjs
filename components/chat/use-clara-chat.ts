"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  WireAttachment,
  WireChatMessage,
  WireTenderRef,
  WireVerdict,
} from "@/lib/ai/agent/wire";
import { SseFrameParser } from "./sse";

/** A composer attachment that finished uploading. */
export interface PendingAttachment extends WireAttachment {
  id: string;
}

export interface ClaraChatState {
  messages: WireChatMessage[];
  /** Assistant text currently streaming (not yet a persisted message). */
  streamingText: string;
  /** Tool currently running, for the status line. */
  activeTool: string | null;
  /** Optional sub-stage of the running tool (verdict pipeline stages). */
  activeStage: string | null;
  /**
   * Tenders the running turn has surfaced, streamed as the tools find them.
   * Emptied once the finished message arrives — it carries them persistently.
   */
  tenderRefs: WireTenderRef[];
  sending: boolean;
  loading: boolean;
  error: string | null;
  verdicts: Record<string, WireVerdict>;
}

/**
 * Chat lifecycle against one chat endpoint (`/api/tenders/{id}/chat` or
 * `/api/chat/threads/{threadId}`): bootstrap, send-with-SSE, abort, clear.
 * Null endpoint = idle (closed popup / no selection).
 */
export function useClaraChat(
  endpoint: string | null,
  options?: { locale?: "en" | "de" },
) {
  const locale = options?.locale ?? "en";
  const [state, setState] = useState<ClaraChatState>({
    messages: [],
    streamingText: "",
    activeTool: null,
    activeStage: null,
    tenderRefs: [],
    sending: false,
    loading: false,
    error: null,
    verdicts: {},
  });
  const abortRef = useRef<AbortController | null>(null);
  // The endpoint currently shown — guards late async writes after switching.
  const endpointRef = useRef(endpoint);
  endpointRef.current = endpoint;

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState({
        messages: [],
        streamingText: "",
        activeTool: null,
        activeStage: null,
        tenderRefs: [],
        sending: false,
        loading: Boolean(endpoint),
        error: null,
        verdicts: {},
      });
      if (!endpoint) return;
      fetch(endpoint, { signal: controller.signal })
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
  }, [endpoint]);

  const post = useCallback(
    (
      body:
        | { message: string; attachmentIds?: string[] }
        | { command: "verdict" },
      optimistic: { text: string; attachments?: WireAttachment[] } | null,
    ) => {
      if (!endpoint) return;
      const controller = new AbortController();
      abortRef.current = controller;
      const optimisticId = `optimistic-${Date.now()}`;

      setState((prev) => ({
        ...prev,
        messages: optimistic
          ? [
              ...prev.messages,
              {
                id: optimisticId,
                role: "user",
                content: optimistic.text,
                status: "complete",
                locale,
                toolEvents: [],
                citations: [],
                attachments: optimistic.attachments,
                verdictId: null,
                createdAt: new Date().toISOString(),
              },
            ]
          : prev.messages,
        streamingText: "",
        activeTool: "command" in body ? "verdict" : null,
        activeStage: null,
        tenderRefs: [],
        sending: true,
        error: null,
      }));

      // Set once the turn's outcome is reflected in state (final "message"
      // or an explicit error event). Without it, the finally block re-syncs
      // history from the server — the SSE stream can die quietly (proxy cut,
      // server turn timeout, dev-mode remount) AFTER the answer or aborted
      // marker was persisted, which otherwise looks like "no output".
      let settled = false;

      void (async () => {
        try {
          const response = await fetch(endpoint, {
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
                  case "ready":
                    // Adopt the persisted id so the optimistic bubble keys stably.
                    return {
                      ...prev,
                      messages: prev.messages.map((message) =>
                        message.id === optimisticId
                          ? { ...message, id: event.messageId }
                          : message,
                      ),
                    };
                  case "token":
                    return {
                      ...prev,
                      streamingText: prev.streamingText + event.delta,
                      activeTool: null,
                      activeStage: null,
                    };
                  case "tool":
                    return {
                      ...prev,
                      activeTool: event.status === "start" ? event.name : null,
                      activeStage:
                        event.status === "start" ? (event.stage ?? null) : null,
                    };
                  case "tenders": {
                    // Merge by id: later events enrich a card already shown
                    // (a decision, a board status) rather than duplicate it.
                    const byId = new Map(
                      prev.tenderRefs.map((ref) => [ref.tenderId, ref]),
                    );
                    for (const ref of event.tenders) byId.set(ref.tenderId, ref);
                    return { ...prev, tenderRefs: [...byId.values()] };
                  }
                  case "artifact":
                    return {
                      ...prev,
                      verdicts: { ...prev.verdicts, [event.verdict.id]: event.verdict },
                    };
                  case "message":
                    settled = true;
                    return {
                      ...prev,
                      messages: [...prev.messages, event.message],
                      streamingText: "",
                      activeTool: null,
                      activeStage: null,
                      // The persisted message now owns the cards.
                      tenderRefs: [],
                    };
                  case "error":
                    settled = true;
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
            activeStage: null,
            streamingText: "",
            // Whatever was persisted carries the cards from here on; keeping
            // the live copy would double them once history re-syncs.
            tenderRefs: [],
          }));
          abortRef.current = null;
          if (!settled && endpointRef.current === endpoint) {
            // The stream ended without a final event (timeout, stop, dropped
            // connection). The server persisted whatever happened — re-sync
            // so the user sees the answer or the aborted marker.
            void fetch(endpoint)
              .then((response) => (response.ok ? response.json() : null))
              .then(
                (json: {
                  messages: WireChatMessage[];
                  verdicts?: WireVerdict[];
                } | null) => {
                  if (!json || endpointRef.current !== endpoint) return;
                  setState((prev) => ({
                    ...prev,
                    messages: json.messages,
                    verdicts: Object.fromEntries(
                      (json.verdicts ?? []).map((verdict) => [verdict.id, verdict]),
                    ),
                  }));
                },
              )
              .catch(() => undefined);
          }
        }
      })();
    },
    [endpoint, locale],
  );

  const send = useCallback(
    (text: string, attachments?: PendingAttachment[]) => {
      const trimmed = text.trim();
      if (!trimmed && !attachments?.length) return;
      post(
        {
          message: text,
          ...(attachments?.length
            ? { attachmentIds: attachments.map((attachment) => attachment.id) }
            : {}),
        },
        {
          text,
          attachments: attachments?.map((attachment) => ({
            fileName: attachment.fileName,
            contentType: attachment.contentType,
            size: attachment.size,
            status: attachment.status,
          })),
        },
      );
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
    if (!endpoint) return;
    void fetch(endpoint, { method: "DELETE" }).then(() =>
      setState((prev) => ({ ...prev, messages: [], verdicts: {}, error: null })),
    );
  }, [endpoint]);

  return { ...state, send, requestVerdict, stop, clear };
}
