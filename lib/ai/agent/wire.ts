/**
 * Client-safe wire types for the Clara chat: serialized documents and the SSE
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

/**
 * A tender one of the turn's tools surfaced, in the shape the chat renders as
 * a clickable card. Collected server-side (lib/ai/agent/tender-refs.ts) so the
 * UI never has to find tender ids in the model's prose.
 */
export interface WireTenderRef {
  tenderId: string;
  title: string | null;
  buyer: string | null;
  status: string | null;
  submissionDeadline: string | null;
  daysUntilDeadline: number | null;
  /** Board column the tender sits in for this company, if any. */
  workspaceStatus: string | null;
  /** Stored report/verdict decision, when a tool surfaced one. */
  decision: "bid" | "no_bid" | "conditional" | null;
  /** 0..1 feed match score — only list_relevant_tenders knows it. */
  matchScore: number | null;
  /** A full report exists, so the card can link straight to it. */
  hasReport: boolean;
}

export interface WireToolEvent {
  name: string;
  durationMs: number;
  resultCount: number | null;
}

export interface WireAttachment {
  fileName: string;
  contentType: string;
  size: number;
  /** ready = Clara read it; unsupported/failed = attached but not readable. */
  status: "ready" | "unsupported" | "failed";
}

export interface WireChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: "complete" | "aborted" | "error";
  locale: "en" | "de";
  toolEvents: WireToolEvent[];
  citations: WireCitation[];
  attachments?: WireAttachment[];
  /** Tenders this answer is about; absent on older documents. */
  tenderRefs?: WireTenderRef[];
  verdictId: string | null;
  createdAt: string;
}

export interface WireThread {
  id: string;
  kind: "tender" | "global";
  tenderId: string | null;
  title: string | null;
  messageCount: number;
  lastMessageAt: string;
}

/** Sidebar listing row: `tenderTitle` is joined in for tender threads. */
export interface WireThreadSummary {
  id: string;
  kind: "tender" | "global";
  title: string | null;
  tenderId: string | null;
  tenderTitle: string | null;
  messageCount: number;
  lastMessageAt: string;
  createdAt: string;
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
export type ClaraSseEvent =
  | { type: "ready"; threadId: string; messageId: string }
  | { type: "token"; delta: string }
  | {
      type: "tool";
      name: string;
      status: "start" | "end";
      resultCount?: number;
      /** Optional i18n sub-stage key (e.g. verdict pipeline stages). */
      stage?: string;
    }
  /** Tenders surfaced so far — sent as they are found, before the answer. */
  | { type: "tenders"; tenders: WireTenderRef[] }
  | { type: "artifact"; artifact: "verdict"; verdict: WireVerdict }
  | { type: "message"; message: WireChatMessage }
  | { type: "error"; message: string };
