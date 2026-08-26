import {
  HumanMessage,
  type BaseMessage,
  type MessageContentComplex,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StreamEvent } from "@langchain/core/tracers/log_stream";
import type { ObjectId } from "mongodb";

import { logger } from "../../ingestion/observability/logger.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import type { ChatAttachmentDocument, ChatMessageDocument } from "../types.ts";
import { attachmentMeta, buildUserTurnContent } from "./attachments.ts";
import { textFromContent } from "./content.ts";
import type { AgentRunContext } from "./context.ts";
import { buildClaraGraph } from "./graph.ts";
import { bumpThread } from "./threads.ts";
import { toolLoopRecursionLimit } from "./tool-loop.ts";
import type { TenderRef } from "./tender-refs.ts";
import type { WireChatMessage, WireUiCall } from "./wire.ts";

const log = logger.child("ai.clara");

/**
 * The only thing `runChatTurn` needs from a compiled graph.
 *
 * Structural rather than `Awaited<ReturnType<typeof buildClaraGraph>>`, which
 * pins the exact node names and state shape — fine while Clara and Dora were
 * the same machine, but it rejects any agent with its own topology (Otto has
 * profile/plan/guide/verify nodes and a wider state). Widening here keeps one
 * turn runner for every agent instead of forking it per graph.
 */
export interface CompiledAgentGraph {
  streamEvents(
    input: { messages: BaseMessage[] },
    options: Partial<RunnableConfig> & { version: "v1" | "v2" },
  ): AsyncIterable<StreamEvent>;
}

export interface ChatTurnCallbacks {
  /** Fired as soon as the user message is persisted, before the model runs. */
  onReady?: (userMessage: ChatMessageDocument) => void;
  onToken?: (delta: string) => void;
  onToolStart?: (name: string) => void;
  onToolEnd?: (name: string, durationMs: number, resultCount: number | null) => void;
  /** New or enriched tender cards, as the tools surface them mid-turn. */
  onTenderRefs?: (refs: TenderRef[]) => void;
  /** Frontend actions the tools requested, streamed as they are registered. */
  onUiCalls?: (calls: WireUiCall[]) => void;
  /**
   * A graph node's state update, as it lands. Only wired up for agents whose
   * UI renders live state (Otto's progress checklist); Clara and Dora pass
   * nothing and pay nothing.
   */
  onState?: (patch: Record<string, unknown>) => void;
}

export { textFromContent };

export function serializeChatMessage(doc: ChatMessageDocument): WireChatMessage {
  return {
    id: String(doc._id),
    role: doc.role,
    content: doc.content,
    status: doc.status,
    locale: doc.locale,
    toolEvents: doc.toolEvents,
    citations: doc.citations as unknown as WireChatMessage["citations"],
    attachments: doc.attachments,
    tenderRefs: doc.tenderRefs,
    verdictId: doc.verdictId ? String(doc.verdictId) : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

export async function persistChatMessage(
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
  /** The stored ChatThreadDocument.threadKey — the LangGraph checkpoint id. */
  threadKey: string;
  userText: string;
  /** Already-claimed attachment docs to feed into this turn. */
  attachments?: ChatAttachmentDocument[];
  signal?: AbortSignal;
  callbacks?: ChatTurnCallbacks;
  /**
   * Graph override for non-Clara agents (a thunk — the caller closes over its
   * own richer context). Defaults to Clara's graph on `ctx`.
   */
  buildGraph?: () => Promise<CompiledAgentGraph>;
  /**
   * Extra multimodal parts appended to the user turn, beyond whatever the
   * attachments produce. Used to hand the model the open document itself when
   * text extraction cannot reach it (a scanned PDF).
   */
  extraContent?: MessageContentComplex[];
  /**
   * Supersteps this graph may take. Every agent passes its own via
   * `toolLoopRecursionLimit(maxIterations, extraNodes)` — LangGraph's default
   * of 25 left the tool loops with three supersteps of headroom, so raising
   * the iteration cap would have thrown GraphRecursionError in production
   * rather than failing a test.
   */
  recursionLimit?: number;
}): Promise<{ userMessage: ChatMessageDocument; assistantMessage: ChatMessageDocument }> {
  const { ctx, threadId, userText, signal, callbacks } = input;
  const attachments = input.attachments ?? [];
  const startedAt = Date.now();

  const userMessage = await persistChatMessage({
    tenantId: ctx.tenantId,
    threadId,
    tenderId: ctx.tender?.tenderId ?? null,
    role: "user",
    content: userText,
    status: "complete",
    locale: ctx.locale,
    toolEvents: [],
    citations: [],
    ...(attachments.length > 0
      ? { attachments: attachments.map(attachmentMeta) }
      : {}),
    verdictId: null,
    metrics: null,
  });
  callbacks?.onReady?.(userMessage);

  // Namespace this turn's UI call ids by the user message they belong to:
  // stable if the turn replays, distinct from every other turn, so the
  // client's de-duplication cannot swallow later turns' actions.
  ctx.uiCalls.setTurnKey(String(userMessage._id));

  // Attachment content rides inside the checkpointed user turn — later turns
  // in this thread keep seeing the files without re-uploading. Document text
  // is inlined; images become checkpoint-light media_ref parts that the graph
  // resolves to base64 at model-call time.
  const built = buildUserTurnContent(userText, attachments);
  const extra = input.extraContent ?? [];
  // A string result has to become a part array before anything can be appended.
  const turnContent =
    extra.length === 0
      ? built
      : [
          ...(typeof built === "string"
            ? built
              ? [{ type: "text", text: built } as MessageContentComplex]
              : []
            : built),
          ...extra,
        ];

  const graph = input.buildGraph ? await input.buildGraph() : await buildClaraGraph(ctx);
  // Every graph gets an explicit superstep budget. The default is sized for
  // the widest tool loop in the product (the global chat's longer iteration
  // cap) plus the four extra nodes Otto's graph adds around it, so no agent
  // relies on LangGraph's default of 25 — which they were all within three
  // supersteps of. Agents whose loops are legitimately longer pass their own.
  const env = aiEnv();
  const config = {
    configurable: { thread_id: input.threadKey },
    signal,
    recursionLimit:
      input.recursionLimit ??
      toolLoopRecursionLimit(
        Math.max(env.agentMaxIterations, env.agentGlobalMaxIterations),
        4,
      ),
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
      { messages: [new HumanMessage({ content: turnContent as never })] },
      { version: "v2", ...config },
    );

    for await (const event of stream) {
      if (event.event === "on_chat_model_stream") {
        const chunk = event.data?.chunk as
          | { content?: unknown; tool_call_chunks?: unknown[] }
          | undefined;
        const delta = textFromContent(chunk?.content);
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
        } else {
          // Authoritative final text (covers models/nodes that didn't stream
          // and array-parts content from thinking models).
          const finalText = textFromContent(output?.content);
          if (finalText) content = finalText;
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
        // Tenders the tool just registered, streamed before the answer text so
        // the reader can already click into them while Clara is still writing.
        const refs = ctx.tenderRefs.drain();
        if (refs.length > 0) callbacks?.onTenderRefs?.(refs);
        // Frontend actions the tool just requested. Sent immediately: a guide
        // that navigates only after finishing its sentence feels broken.
        const uiCalls = ctx.uiCalls.drain();
        if (uiCalls.length > 0) callbacks?.onUiCalls?.(uiCalls);
      } else if (callbacks?.onState && event.event === "on_chain_end") {
        // A graph node just returned its state update. `langgraph_node` is
        // absent on the outer chain events, which is what keeps this from
        // echoing the whole state on every step.
        const node = (event.metadata as { langgraph_node?: string } | undefined)
          ?.langgraph_node;
        const output = event.data?.output;
        if (node && output && typeof output === "object" && !Array.isArray(output)) {
          // `messages` streams as tokens already and can hold non-serializable
          // model objects; everything else is the agent's own state.
          const patch = Object.fromEntries(
            Object.entries(output as Record<string, unknown>).filter(
              ([key]) => key !== "messages",
            ),
          );
          if (Object.keys(patch).length > 0) callbacks.onState(patch);
        }
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      status = "aborted";
      log.info("chat turn aborted", { threadKey: input.threadKey });
    } else {
      status = "error";
      log.error("chat turn failed", {
        threadKey: input.threadKey,
        error: String(error),
      });
      if (content.length === 0) content = "";
    }
  }

  // The whole turn's cards, not just the last drain — history must restore
  // every tender the answer talks about.
  const tenderRefs = ctx.tenderRefs.list();

  const assistantMessage = await persistChatMessage({
    tenantId: ctx.tenantId,
    threadId,
    tenderId: ctx.tender?.tenderId ?? null,
    role: "assistant",
    content,
    status,
    locale: ctx.locale,
    toolEvents,
    citations: ctx.citations.list() as unknown as Array<Record<string, unknown>>,
    ...(tenderRefs.length > 0 ? { tenderRefs } : {}),
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
