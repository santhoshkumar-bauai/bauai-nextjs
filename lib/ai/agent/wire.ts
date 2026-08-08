/**
 * Client-safe wire types for the Dora chat: serialized documents and the SSE
 * event protocol. This module must import NOTHING server-side (no mongodb, no
 * node:crypto) — it is the only agent module components may import.
 */

export interface WireCitation {
  key: string;
  quote: string;
  fileName: string;
  documentRecordId: string | null;
  chunkId: string | null;
}

export interface WireToolEvent {
  name: string;
  durationMs: number;
  resultCount: number | null;
}

export interface WireChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "aborted" | "error";
  locale: "en" | "de";
  toolEvents: WireToolEvent[];
  citations: WireCitation[];
  verdictId: string | null;
  createdAt: string;
}

export interface WireThread {
  id: string;
  tenderId: string;
  messageCount: number;
  lastMessageAt: string;
}

export interface WireVerdict {
  id: string;
  recommendation: "bid" | "no_bid" | "conditional";
  rationale: string;
  scoreBreakdown: {
    eligibilityFit: number;
    strategicFit: number;
    capacityFit: number;
    contractRisk: number;
    deadlineFeasibility: number;
  };
  risks: Array<{
    text: string;
    severity: "low" | "medium" | "high";
    citations: WireCitation[];
    uncited?: boolean;
  }>;
  blockingRequirements: Array<{ text: string; citations: WireCitation[] }>;
  unresolvedQuestions: string[];
  stale: boolean;
  locale: "en" | "de";
  generatedAt: string;
}

/** SSE events the chat route emits. Tool labels are i18n KEYS, not text. */
export type DoraSseEvent =
  | { type: "ready"; threadId: string; messageId: string }
  | { type: "token"; delta: string }
  | { type: "tool"; name: string; status: "start" | "end"; resultCount?: number }
  | { type: "artifact"; artifact: "verdict"; verdict: WireVerdict }
  | { type: "message"; message: WireChatMessage }
  | { type: "error"; message: string };
