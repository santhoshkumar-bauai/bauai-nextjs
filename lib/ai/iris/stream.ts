import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type InferUIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";

import { textFromContent } from "../agent/content.ts";
import { classifyAiError } from "../agent/errors.ts";
import type { IrisRunContext } from "./context.ts";
import { buildFollowups } from "./followups.ts";
import { buildIrisGraph, IRIS_RECURSION_LIMIT } from "./graph.ts";
import { tenderIdsOf, toLangChainHistory } from "./history.ts";
import type { IrisUIMessage } from "./wire.ts";

/**
 * The bridge: LangGraph's `streamEvents` on one side, the Vercel AI SDK's UI
 * message stream on the other.
 *
 * Clara's route (`lib/ai/agent/sse-turn.ts`) hand-rolls an SSE protocol and a
 * matching client parser. This does the same job in a third of the code by
 * speaking the AI SDK's wire format instead, which buys `useChat` on the
 * client: message state, reconnection, streaming reconciliation and typed
 * parts, none of which we have to own.
 *
 * The mapping is:
 *
 *   on_chat_model_stream  → text-start / text-delta / text-end
 *   on_tool_start / _end  → tool-input-available / tool-output-available
 *   BlockEmitter          → data-<block kind>, reconciled by id
 *
 * Blocks do NOT come from the tool events. A tool's return value is the short
 * ack the model reads; the rendered payload rides its own channel so the UI
 * can show a skeleton the moment the call starts and the model never has to
 * pay for the pixels.
 */

/** Iris turns are short by construction; this is a runaway guard, not a budget. */
const TURN_TIMEOUT_MS = 120_000;

type Chunk = InferUIMessageChunk<IrisUIMessage>;

// ---------------------------------------------------------------------------
// Turn
// ---------------------------------------------------------------------------

export function streamIrisTurn(input: {
  ctx: IrisRunContext;
  messages: IrisUIMessage[];
  request: Request;
}): Response {
  const { ctx, messages, request } = input;

  // Composed exactly like the Clara route: client disconnect OR hard timeout.
  const turnController = new AbortController();
  const timeout = setTimeout(() => turnController.abort(), TURN_TIMEOUT_MS);
  request.signal.addEventListener("abort", () => turnController.abort(), { once: true });

  // Ids are namespaced by the user turn that caused them, so a replay or a
  // reconnect re-emits the SAME block ids and the client reconciles instead of
  // stacking a second copy of every grid. Same trap as `UiCallCollector`.
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  ctx.blocks.setTurnKey(lastUser?.id ?? "turn");

  const stream = createUIMessageStream<IrisUIMessage>({
    onError: (error) => classifyAiError(error),
    execute: async ({ writer }) => {
      const startedAt = Date.now();
      let focusTenderId: string | null = null;
      let wroteText = false;

      writer.write({ type: "start" });

      const unsubscribe = ctx.blocks.subscribe((event) => {
        if (event.state.status === "ready") {
          focusTenderId = tenderIdsOf(event.kind, event.state.block)[0] ?? focusTenderId;
        }
        // The chunk type is `data-${BlockKind}`, which TypeScript cannot narrow
        // from a runtime string. The emitter is the only producer and it is
        // keyed by the same catalog, so the shape is guaranteed by construction.
        writer.write({
          type: `data-${event.kind}`,
          id: event.id,
          data: event.state,
        } as Chunk);
      });

      try {
        const graph = await buildIrisGraph(ctx);
        const events = graph.streamEvents(
          { messages: toLangChainHistory(messages) },
          {
            version: "v2",
            recursionLimit: IRIS_RECURSION_LIMIT,
            signal: turnController.signal,
          },
        );

        // One text part per model call. Opened lazily on the first non-empty
        // delta: a tool-calling turn streams an empty content array first, and
        // an empty text part renders as a stray blank bubble.
        let textId: string | null = null;
        let textSequence = 0;

        for await (const event of events) {
          switch (event.event) {
            case "on_chat_model_stream": {
              const chunk = (event.data as { chunk?: { content?: unknown } })?.chunk;
              const delta = textFromContent(chunk?.content);
              if (!delta) break;
              if (textId === null) {
                textSequence += 1;
                textId = `iris-text-${textSequence}`;
                writer.write({ type: "text-start", id: textId });
              }
              wroteText = true;
              writer.write({ type: "text-delta", id: textId, delta });
              break;
            }
            case "on_chat_model_end": {
              if (textId !== null) {
                writer.write({ type: "text-end", id: textId });
                textId = null;
              }
              break;
            }
            case "on_tool_start": {
              writer.write({
                type: "tool-input-start",
                toolCallId: event.run_id,
                toolName: event.name,
              });
              writer.write({
                type: "tool-input-available",
                toolCallId: event.run_id,
                toolName: event.name,
                input: (event.data as { input?: unknown })?.input ?? {},
              });
              break;
            }
            case "on_tool_end": {
              const output = (event.data as { output?: unknown })?.output;
              writer.write({
                type: "tool-output-available",
                toolCallId: event.run_id,
                // ToolNode turns a thrown tool into a ToolMessage rather than
                // crashing the graph, so the ack may be an error string. It is
                // ours either way — never a raw provider message.
                output:
                  typeof output === "string"
                    ? output
                    : textFromContent((output as { content?: unknown })?.content) ||
                      JSON.stringify(output ?? null),
              });
              break;
            }
            default:
              break;
          }
        }

        if (textId !== null) writer.write({ type: "text-end", id: textId });

        const renderedKinds = ctx.blocks.renderedKinds();

        // A turn that produced neither prose nor a block is a failure the user
        // would otherwise see as an empty bubble.
        if (!wroteText && renderedKinds.length === 0) {
          writer.write({ type: "error", errorText: "failed" });
        }

        const followups = buildFollowups({
          locale: ctx.locale,
          renderedKinds,
          focusTenderId,
        });
        if (followups.suggestions.length > 0) {
          writer.write({ type: "data-followups", data: followups });
        }

        writer.write({
          type: "finish",
          messageMetadata: {
            agent: "iris",
            locale: ctx.locale,
            durationMs: Date.now() - startedAt,
            blockCount: renderedKinds.length,
          },
        });
      } finally {
        unsubscribe();
        clearTimeout(timeout);
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}

/** Narrow helper kept beside the writer it feeds; exported for the tests. */
export type IrisStreamWriter = UIMessageStreamWriter<IrisUIMessage>;
