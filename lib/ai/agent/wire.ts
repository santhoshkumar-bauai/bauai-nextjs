/**
 * Client-safe wire types for the Clara chat: serialized documents and the SSE
 * event protocol. This module must import NOTHING server-side (no mongodb, no
 * node:crypto) — it is the only agent module components may import.
 */

import type {
  WireDoraEditStatusStage,
  WireDoraEditTransaction,
} from "../dora/edit-wire.ts";
import type { WireSpreadsheetChangeSet } from "../dora/spreadsheet/edit-wire.ts";

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

/**
 * One frontend-executed action the agent asked for.
 *
 * `args` is deliberately `unknown`: the client re-validates it against the
 * action's own schema before dispatching, so a malformed or unexpected payload
 * is a logged no-op rather than a runtime throw. The model never puts a
 * selector or a URL in here — only identifiers the server already validated
 * against a registry.
 */
export interface WireUiCall {
  /** Stable per-call id, so the client can de-duplicate on reconnect. */
  id: string;
  action: string;
  args: unknown;
}

/** A question the graph paused on, rendered as buttons instead of free text. */
export interface WireInterrupt {
  interruptId: string;
  /** i18n key for the question — never user-visible text. */
  promptKey: string;
  choices: Array<{ id: string; labelKey: string }>;
  /** When true the user may also answer in prose instead of picking. */
  allowFreeText?: boolean;
}

/** SSE events the chat routes emit. Tool labels are i18n KEYS, not text. */
export type AgentSseEvent =
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
  /**
   * A shallow patch of the agent's own graph state, pushed as it changes, so
   * the UI can render live progress instead of polling. Shape is per-agent;
   * consumers narrow it themselves.
   */
  | { type: "state"; patch: Record<string, unknown> }
  /** Actions for the client to execute — navigation, spotlighting, seeding. */
  | { type: "ui"; calls: WireUiCall[] }
  /** Dora V2 emits explicit edit lifecycle events instead of generic UI calls. */
  | { type: "edit_status"; stage: WireDoraEditStatusStage; detail?: string }
  | { type: "edit_transaction"; transaction: WireDoraEditTransaction }
  | { type: "spreadsheet_change_set"; changeSet: WireSpreadsheetChangeSet }
  /** Streaming edit tier: raw text deltas the editor writes into the document
   * at the insertion point. Deliberately separate from `token`, which is wired
   * to chat-message rendering. */
  | { type: "edit_delta"; turnId: string; text: string }
  | {
      type: "edit_result";
      transactionId: string;
      state:
        | "planned"
        | "streamed"
        | "applied"
        | "accepted"
        | "rejected"
        | "stale"
        | "rolled_back"
        | "aborted"
        | "failed";
      failureCode?: string;
      /** Stream tier: the complete generated text, for consolidation. */
      finalText?: string;
      results: Array<{
        opId: string;
        state: "applied" | "accepted" | "rejected" | "stale" | "rolled_back" | "failed";
        failureCode?: string;
      }>;
    }
  /** The graph paused for a human answer; resume via the agent's resume route. */
  | { type: "interrupt"; interrupt: WireInterrupt }
  | { type: "message"; message: WireChatMessage }
  | { type: "error"; message: string };

/**
 * @deprecated Named for Clara before Dora and Otto shared the protocol. Kept
 * so existing imports keep resolving; prefer `AgentSseEvent`.
 */
export type ClaraSseEvent = AgentSseEvent;
