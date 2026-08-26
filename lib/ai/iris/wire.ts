import type { UIMessage } from "ai";

import type { BlockKind, BlockState } from "./blocks.ts";

/**
 * The client-safe contract between Iris's route and the React tree.
 *
 * Everything here is types only. This module must import NOTHING server-side —
 * it is the one Iris module components are allowed to reach for, exactly like
 * `lib/ai/agent/wire.ts` is for Clara.
 *
 * Where Clara hand-rolls an SSE event union, Iris rides the AI SDK's UI message
 * stream instead, so the shape below is expressed in the SDK's own generics:
 *
 *   metadata    → per-turn facts the header shows (locale, model role, timing)
 *   data parts  → the generative-UI blocks, one `data-<kind>` per catalog entry
 *   tools       → the LangGraph tool calls, surfaced as the activity rail
 */

/** One generative-UI block per catalog kind, streamed as `data-<kind>`. */
type BlockDataParts = { [K in BlockKind]: BlockState<K> };

export interface IrisFollowups {
  suggestions: Array<{ label: string; prompt: string }>;
}

/** Transient toast-style signal; never persisted into `message.parts`. */
export interface IrisNotice {
  level: "info" | "warning" | "error";
  message: string;
}

export type IrisDataParts = BlockDataParts & {
  followups: IrisFollowups;
  notice: IrisNotice;
};

/**
 * Tool names, fixed so the activity rail can label a call the moment it starts
 * — before any output exists. i18n keys are derived from the name
 * (`GenUi.tools.<name>`), which keeps the catalog and the labels from drifting.
 */
export const IRIS_TOOL_NAMES = [
  "show_portfolio_metrics",
  "show_opportunity_feed",
  "show_tender_spotlight",
  "compare_tenders_view",
  "show_bid_verdict",
  "show_requirements",
  "show_deadlines",
  "show_tender_documents",
  "show_company_documents",
  "search_evidence",
  "show_pipeline_board",
  "explore_cpv_codes",
  "show_company_snapshot",
  "ask_user_choice",
  "offer_filters",
] as const;

export type IrisToolName = (typeof IRIS_TOOL_NAMES)[number];

export function isIrisToolName(value: string): value is IrisToolName {
  return (IRIS_TOOL_NAMES as readonly string[]).includes(value);
}

/**
 * Tool input/output as the UI sees them.
 *
 * `output` is the short JSON ack the tool hands back to the MODEL, not the
 * block — the rich payload travels as a data part. Keeping them apart is what
 * lets a 15-tender grid cost the model ~200 tokens.
 */
export type IrisTools = {
  [N in IrisToolName]: { input: Record<string, unknown>; output: string };
};

export interface IrisMessageMetadata {
  /** Which agent produced the turn; the POC ships one, the shape allows more. */
  agent?: "iris";
  locale?: "en" | "de";
  /** Wall-clock for the whole turn, stamped on `finish`. */
  durationMs?: number;
  /** Blocks rendered this turn — drives the "N views" chip in the header. */
  blockCount?: number;
}

export type IrisUIMessage = UIMessage<IrisMessageMetadata, IrisDataParts, IrisTools>;

/** Request body the composer posts; `id` is the client-side chat id. */
export interface IrisChatRequestBody {
  id?: string;
  messages: IrisUIMessage[];
}
