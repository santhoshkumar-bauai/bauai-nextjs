import type { WireCitation } from "../agent/wire.ts";

/**
 * Client-safe wire types for the Dora panel. Like lib/ai/agent/wire.ts, this
 * module must import NOTHING server-side (no mongodb, no node:crypto) — it is
 * the only Dora module components may import. Chat reuses ClaraSseEvent and
 * WireChatMessage unchanged.
 */

export type { WireCitation };

export interface WireBriefDeadline {
  label: string;
  date: string | null;
  citations: WireCitation[];
}

export interface WireBriefAction {
  step: string;
  detail: string;
  citations: WireCitation[];
}

export interface WireBriefValue {
  field: string;
  value: string;
  source: "document" | "tender" | "company";
  citations: WireCitation[];
}

export interface WireBriefRisk {
  text: string;
  severity: "low" | "medium" | "high";
  citations: WireCitation[];
}

export interface WireDocumentBrief {
  documentType: string;
  purpose: string;
  summary: string;
  keyRequirements: Array<{ text: string; citations: WireCitation[] }>;
  deadlines: WireBriefDeadline[];
  requiredActions: WireBriefAction[];
  suggestedValues: WireBriefValue[];
  missingInfo: string[];
  risks: WireBriefRisk[];
  /** The document changed since this brief was generated. */
  stale: boolean;
  generatedAt: string;
  /** storageRevision of the version the brief analyzed. */
  analyzedRevision: number;
  /** How the document text was read; drives limitation notices. */
  textStatus: "ready" | "unsupported" | "failed";
  textNote: string | null;
}

export interface WireBriefRunState {
  status: "running" | "done" | "failed";
  stage:
    | "saving_editor"
    | "extracting"
    | "grounding"
    | "analyzing"
    | "translating"
    | "saving";
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** GET /api/workspace-documents/[id]/dora/brief */
export interface WireBriefStatus {
  run: WireBriefRunState | null;
  brief: WireDocumentBrief | null;
  current: { storageRevision: number };
}

export const DORA_BRIEF_STAGES = [
  "saving_editor",
  "extracting",
  "grounding",
  "analyzing",
  "translating",
  "saving",
] as const;
