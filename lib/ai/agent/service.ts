import { HumanMessage } from "@langchain/core/messages";
import type { ObjectId } from "mongodb";

import { logger } from "../../ingestion/observability/logger.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatMessageDocument } from "../types.ts";
import type { AgentRunContext } from "./context.ts";
import { buildDoraGraph } from "./graph.ts";
import { bumpThread, threadKey } from "./threads.ts";
import type { WireChatMessage } from "./wire.ts";

const log = logger.child("ai.dora");

export interface ChatTurnCallbacks {
  /** Fired as soon as the user message is persisted, before the model runs. */
  onReady?: (userMessage: ChatMessageDocument) => void;
  onToken?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, durationMs: number, resultCount: number | null) => void;
}

export function serializeChatMessage(doc: ChatMessageDocument): WireChatMessage {
  return {
    id: String(doc._id),
    role: doc.role,
    content: doc.content,
    status: doc.status,
    locale: doc.locale,
    toolEvents: doc.toolEvents,
    citations: doc.citations as unknown as WireChatMessage["citations"],
    verdictId: doc.verdictId ? String(doc.verdictId) : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

async function persistMessage(
  message: Omit<ChatMessageDocument, "_id" | "createdAt" | "updatedAt">,
): Promise<ChatMessageDocument> {
  const { chatMessages } = await getAiCollections();
  const now = new Date();
  const doc: ChatMessageDocument = { ...message, createdAt: now, updatedAt: now };
  const result = await chatMessages.insertOne(doc as never);
  return { ...doc, _id: result.insertedId as ObjectId };
}

/**
 * One chat turn: persist the user message, stream the graph (tokens + coarse
 * tool events via callbacks), persist and return the assistant message. On
 * abort the partial content is persisted with status "aborted".
 */
export async function runChatTurn(input: {
  ctx: AgentRunContext;
  threadId: ObjectId;
  userText: string;
  signal?: AbortSignal;
  callbacks?: ChatTurnCallbacks;
}): Promise<{ userMessage: ChatMessageDocument; assistantMessage: ChatMessageDocument }> {
  const { ctx, threadId, userText, signal, callbacks } = input;
  const startedAt = Date.now();

  const userMessage = await persistMessage({
    tenantId: ctx.tenantId,
    threadId,
    tenderId: ctx.tenderId,
    role: "user",
    content: userText,
    status: "complete",
    locale: ctx.locale,
    toolEvents: [],
    citations: [],
    verdictId: null,
    metrics: null,
  });
  callbacks?.onReady?.(userMessage);

  const graph = await buildDoraGraph(ctx);
  const config = {
    configurable: { thread_id: threadKey(ctx.tenantId, ctx.tenderId) },
    signal,
  };

  let content = "";
  let status: ChatMessageDocument["status"] = "complete";
  const toolEvents: ChatMessageDocument["toolEvents"] = [];
  const toolStarts = new Map<string, number>();
  let llmCalls = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    const stream = graph.streamEvents(
      { messages: [new HumanMessage(userText)] },
      { version: "v2", ...config },
    );

    for await (const event of stream) {
      if (event.event === "on_chat_model_stream") {
        const chunk = event.data?.chunk as
          | { content?: unknown; tool_call_chunks?: unknown[] }
          | undefined;
        const delta = typeof chunk?.content === "string" ? chunk.content : "";
        if (delta) {
          content += delta;
          callbacks?.onToken?.(delta);
        }
      } else if (event.event === "on_chat_model_end") {
        llmCalls += 1;
        const output = event.data?.output as
          | {
              content?: unknown;
              tool_calls?: unknown[];
              usage_metadata?: { input_tokens?: number; output_tokens?: number };
            }
          | undefined;
        inputTokens += output?.usage_metadata?.input_tokens ?? 0;
        outputTokens += output?.usage_metadata?.output_tokens ?? 0;
        if (Array.isArray(output?.tool_calls) && output.tool_calls.length > 0) {
          // A tool-requesting turn streams no user-visible text; reset the
          // buffer so only the final answer accumulates.
          content = "";
        } else if (typeof output?.content === "string" && output.content) {
          // Authoritative final text (covers models/nodes that didn't stream).
          content = output.content;
        }
      } else if (event.event === "on_tool_start") {
        toolStarts.set(event.run_id, Date.now());
        callbacks?.onToolStart?.(event.name);
      } else if (event.event === "on_tool_end") {
        const started = toolStarts.get(event.run_id) ?? Date.now();
        const durationMs = Date.now() - started;
        let resultCount: number | null = null;
        try {
          const raw = (event.data?.output as { content?: string })?.content;
          const parsed = raw ? JSON.parse(raw) : null;
          if (Array.isArray(parsed)) resultCount = parsed.length;
        } catch {
          resultCount = null;
        }
        toolEvents.push({ name: event.name, durationMs, resultCount });
        callbacks?.onToolEnd?.(event.name, durationMs, resultCount);
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      status = "aborted";
      log.info("chat turn aborted", { tenderId: String(ctx.tenderId) });
    } else {
      status = "error";
      log.error("chat turn failed", {
        tenderId: String(ctx.tenderId),
        error: String(error),
      });
      if (content.length === 0) content = "";
    }
  }

  const assistantMessage = await persistMessage({
    tenantId: ctx.tenantId,
    threadId,
    tenderId: ctx.tenderId,
    role: "assistant",
    content,
    status,
    locale: ctx.locale,
    toolEvents,
    citations: ctx.citations.list() as unknown as Array<Record<string, unknown>>,
    verdictId: null,
    metrics: {
      llmCalls,
      inputTokens,
      outputTokens,
      durationMs: Date.now() - startedAt,
    },
  });

  await bumpThread(ctx.tenantId, threadId, 2);
  return { userMessage, assistantMessage };
}
