import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

import type { BlockKind, BlockState } from "./blocks.ts";
import type { IrisUIMessage } from "./wire.ts";

/**
 * `UIMessage[]` → LangChain history.
 *
 * Iris keeps its conversation on the CLIENT (see `graph.ts` on why there is no
 * checkpointer), so every turn arrives as the AI SDK's full message array and
 * has to be converted back. Two decisions carry the weight:
 *
 * 1. Tool parts are dropped, not replayed. Rebuilding a faithful tool-call /
 *    tool-message pairing out of UI parts is exactly the class of history
 *    damage `sanitizeToolPairs` exists to repair, and Gemini hard-rejects a
 *    malformed one.
 * 2. A `[rendered: kind[ids]]` note is appended to each assistant turn
 *    instead. Without it the model's history is prose with holes in it: it
 *    wrote "three of these close inside a week" and has no record of what
 *    "these" were, so the next turn re-fetches the feed to answer "the second
 *    one" — or worse, guesses.
 */

function textOf(message: IrisUIMessage): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

/** The tender ids a rendered block is about, per kind. */
export function tenderIdsOf(kind: BlockKind, block: unknown): string[] {
  const value = block as Record<string, never>;
  switch (kind) {
    case "tender-grid":
      return ((value.items as { tenderId: string }[] | undefined) ?? []).map(
        (item) => item.tenderId,
      );
    case "tender-spotlight":
      return [(value.tender as { tenderId: string } | undefined)?.tenderId].filter(
        (id): id is string => Boolean(id),
      );
    case "tender-compare":
      return ((value.columns as { tenderId: string }[] | undefined) ?? []).map(
        (column) => column.tenderId,
      );
    case "bid-verdict":
      return [value.tenderId as string | undefined].filter((id): id is string => Boolean(id));
    case "pipeline-board":
      return ((value.columns as { items: { tenderId: string }[] }[] | undefined) ?? []).flatMap(
        (column) => column.items.map((item) => item.tenderId),
      );
    default:
      return [];
  }
}

/** Terse record of what an earlier turn put on screen. Never the payload. */
export function renderedNote(message: IrisUIMessage): string {
  const notes: string[] = [];
  for (const part of message.parts) {
    if (!part.type.startsWith("data-")) continue;
    const kind = part.type.slice("data-".length) as BlockKind;
    const data = (part as { data?: BlockState<BlockKind> }).data;
    // Skeletons and empty states are not "on screen" in any useful sense.
    if (!data || data.status !== "ready") continue;
    const ids = tenderIdsOf(kind, data.block);
    notes.push(ids.length > 0 ? `${kind}[${ids.join(",")}]` : kind);
  }
  return notes.length > 0 ? `\n[rendered: ${notes.join(" ")}]` : "";
}

export function toLangChainHistory(messages: IrisUIMessage[]): BaseMessage[] {
  const history: BaseMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      const text = textOf(message);
      if (text) history.push(new HumanMessage(text));
      continue;
    }
    if (message.role !== "assistant") continue;
    const content = `${textOf(message)}${renderedNote(message)}`.trim();
    if (content) history.push(new AIMessage(content));
  }
  return history;
}
