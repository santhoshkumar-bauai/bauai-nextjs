"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { WireChatMessage, WireUiCall } from "@/lib/ai/agent/wire";
import type { OttoWireState } from "@/lib/ai/otto/wire";
import type { MilestoneId } from "@/lib/onboarding/milestones";
import { SseFrameParser } from "@/components/chat/sse";

/**
 * Otto's stream hook. A sibling of `useClaraChat` rather than a reuse of it:
 * Otto has no threads sidebar, no attachments, no verdicts and no tender
 * cards, but it does have two things Clara has never needed — live graph state
 * and frontend actions to dispatch. Bending the Clara hook to cover both would
 * make the surface that three chat UIs share strictly worse.
 *
 * The SSE frame parser itself IS shared (components/chat/sse.ts).
 */

export interface OttoSummary {
  status: "not_started" | "in_progress" | "dismissed" | "completed";
  plannedMilestoneIds: MilestoneId[];
  completedMilestoneIds: MilestoneId[];
  currentMilestoneId: MilestoneId | null;
}

interface OttoChatState {
  messages: WireChatMessage[];
  streamingText: string;
  agentState: OttoWireState | null;
  summary: OttoSummary | null;
  loading: boolean;
  sending: boolean;
  error: string | null;
}

const ENDPOINT = "/api/otto/chat";

const INITIAL: OttoChatState = {
  messages: [],
  streamingText: "",
  agentState: null,
  summary: null,
  loading: true,
  sending: false,
  error: null,
};

export function useOttoChat(input: {
  /** Dispatches `ui` events to the registered frontend actions. */
  onUiCalls: (calls: WireUiCall[]) => void | Promise<void>;
  /** Client context sent with each turn, so Otto knows where the user is. */
  readReadables: () => Record<string, unknown>;
  enabled: boolean;
}) {
  const [state, setState] = useState<OttoChatState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const bootstrapped = useRef(false);

  // Latest-ref so `send` stays stable while still calling current callbacks.
  const uiRef = useRef(input.onUiCalls);
  const readablesRef = useRef(input.readReadables);
  useEffect(() => {
    uiRef.current = input.onUiCalls;
    readablesRef.current = input.readReadables;
  }, [input.onUiCalls, input.readReadables]);

  const bootstrap = useCallback(async () => {
    try {
      const response = await fetch(ENDPOINT);
      if (!response.ok) throw new Error("failed");
      const data = (await response.json()) as {
        messages: WireChatMessage[];
        state: OttoWireState | null;
        summary: OttoSummary;
      };
      setState((prev) => ({
        ...prev,
        messages: data.messages,
        agentState: data.state,
        summary: data.summary,
        loading: false,
      }));
    } catch {
      setState((prev) => ({ ...prev, loading: false, error: "failed" }));
    }
  }, []);

  useEffect(() => {
    if (!input.enabled || bootstrapped.current) return;
    bootstrapped.current = true;
    void bootstrap();
  }, [input.enabled, bootstrap]);

  const send = useCallback(
    (message: string) => {
      const text = message.trim();
      if (!text) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const optimistic: WireChatMessage = {
        id: `optimistic-${Date.now()}`,
        role: "user",
        content: text,
        status: "complete",
        locale: "en",
        toolEvents: [],
        citations: [],
        verdictId: null,
        createdAt: new Date().toISOString(),
      };

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, optimistic],
        streamingText: "",
        sending: true,
        error: null,
      }));

      void (async () => {
        let settled = false;
        try {
          const response = await fetch(ENDPOINT, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              message: text,
              clientContext: readablesRef.current(),
            }),
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
              // Dispatch outside setState: running navigation and spotlighting
              // inside a state updater would fire twice under StrictMode.
              if (event.type === "ui") {
                void uiRef.current(event.calls);
                continue;
              }
              setState((prev) => {
                switch (event.type) {
                  case "ready":
                    return {
                      ...prev,
                      messages: prev.messages.map((item) =>
                        item.id === optimistic.id
                          ? { ...item, id: event.messageId }
                          : item,
                      ),
                    };
                  case "token":
                    return { ...prev, streamingText: prev.streamingText + event.delta };
                  case "state":
                    return {
                      ...prev,
                      agentState: {
                        ...(prev.agentState ?? ({} as OttoWireState)),
                        ...(event.patch as Partial<OttoWireState>),
                      } as OttoWireState,
                    };
                  case "message":
                    settled = true;
                    return {
                      ...prev,
                      messages: [...prev.messages, event.message],
                      streamingText: "",
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
            setState((prev) => ({
              ...prev,
              error: error instanceof Error ? error.message : "failed",
            }));
          }
        } finally {
          setState((prev) => ({ ...prev, sending: false, streamingText: "" }));
          abortRef.current = null;
          // Re-bootstrap regardless: it re-reads the authoritative graph state
          // AND is where the server reconciles the durable progress mirror.
          // A stream can also die quietly after the turn was persisted.
          void bootstrap();
          if (!settled) {
            setState((prev) => ({ ...prev, error: prev.error ?? null }));
          }
        }
      })();
    },
    [bootstrap],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((prev) => ({ ...prev, sending: false }));
  }, []);

  return { ...state, send, stop, refresh: bootstrap };
}
