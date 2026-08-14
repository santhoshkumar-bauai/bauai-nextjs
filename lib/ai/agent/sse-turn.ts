import type { ChatThreadDocument } from "../types.ts";
import { claimChatAttachments } from "./attachments.ts";
import type { AgentRunContext, TenderAgentRunContext } from "./context.ts";
import {
  runChatTurn,
  serializeChatMessage,
  type CompiledAgentGraph,
} from "./service.ts";
import { setThreadTitleIfEmpty } from "./threads.ts";
import type { ClaraSseEvent } from "./wire.ts";

/**
 * The one SSE-over-POST implementation behind both chat routes (per-tender
 * and per-thread). Frames `event: {type}\ndata: {json}\n\n`, 25s keep-alive
 * heartbeat, hard per-turn timeout composed with client disconnect. Errors
 * collapse to i18n keys ("rate_limited" | "failed") — never raw messages.
 */

const HEARTBEAT_INTERVAL_MS = 25_000;
// Safety net only — generous enough that no legitimate agent run ever hits
// it. Global chats chain find_tenders → notice → document search across up
// to 8 iterations; killing them mid-run surfaces as "Stopped" bubbles.
const TURN_TIMEOUT_MS = 300_000;

export type ChatTurnBody =
  | { message: string; attachmentIds?: string[] }
  | { command: "verdict" };

export function streamChatTurnResponse(input: {
  ctx: AgentRunContext;
  thread: ChatThreadDocument;
  body: ChatTurnBody;
  request: Request;
  /** Graph override for non-Clara agents; see runChatTurn. */
  buildGraph?: () => Promise<CompiledAgentGraph>;
  /**
   * Stream graph state patches as `state` events. Off by default — only
   * agents whose UI renders live state (Otto) need it, and Clara's and Dora's
   * node outputs are nothing the client should see.
   */
  streamState?: boolean;
}): Response {
  const { ctx, thread, body, request } = input;
  const encoder = new TextEncoder();

  // Compose client disconnect with a hard per-turn timeout.
  const turnController = new AbortController();
  const timeout = setTimeout(() => turnController.abort(), TURN_TIMEOUT_MS);
  request.signal.addEventListener("abort", () => turnController.abort(), {
    once: true,
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;

      const send = (event: ClaraSseEvent) => {
        if (!open) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          open = false;
        }
      };

      const heartbeat = setInterval(() => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          open = false;
        }
      }, HEARTBEAT_INTERVAL_MS);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        clearTimeout(timeout);
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      void (async () => {
        try {
          if ("command" in body) {
            if (!ctx.tender) {
              // Verdicts are tender-scoped; global threads cannot request one.
              send({ type: "error", message: "failed" });
              return;
            }
            await runVerdictCommand(ctx as TenderAgentRunContext, thread, send);
            return;
          }

          // Only the uploader's own unclaimed files resolve; forged ids drop.
          const attachments = body.attachmentIds?.length
            ? await claimChatAttachments({
                tenantId: ctx.tenantId,
                userId: ctx.userId,
                ids: body.attachmentIds,
              })
            : [];

          // First message of an untitled global thread names the session.
          if (thread.kind === "global" && thread.title === null) {
            const titleSeed = body.message.trim() || attachments[0]?.fileName;
            if (titleSeed) {
              await setThreadTitleIfEmpty(ctx.tenantId, thread._id!, titleSeed);
            }
          }

          const result = await runChatTurn({
            ctx,
            threadId: thread._id!,
            threadKey: thread.threadKey,
            userText: body.message,
            attachments,
            buildGraph: input.buildGraph,
            signal: turnController.signal,
            callbacks: {
              onReady: (userMessage) =>
                send({
                  type: "ready",
                  threadId: String(thread._id),
                  messageId: String(userMessage._id),
                }),
              onToken: (delta) => send({ type: "token", delta }),
              onToolStart: (name) => send({ type: "tool", name, status: "start" }),
              onToolEnd: (name, _durationMs, resultCount) =>
                send({
                  type: "tool",
                  name,
                  status: "end",
                  resultCount: resultCount ?? undefined,
                }),
              onTenderRefs: (tenders) => send({ type: "tenders", tenders }),
              onUiCalls: (calls) => send({ type: "ui", calls }),
              onState: input.streamState
                ? (patch) => send({ type: "state", patch })
                : undefined,
            },
          });
          send({
            type: "message",
            message: serializeChatMessage(result.assistantMessage),
          });
        } catch (error) {
          send({
            type: "error",
            message:
              error instanceof Error && /rate.?limit/i.test(error.message)
                ? "rate_limited"
                : "failed",
          });
        } finally {
          close();
        }
      })();
    },
    cancel() {
      turnController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

/** Verdict command: deterministic pipeline, not a model tool loop. */
async function runVerdictCommand(
  ctx: TenderAgentRunContext,
  thread: ChatThreadDocument,
  send: (event: ClaraSseEvent) => void,
): Promise<void> {
  const { generateVerdict, serializeVerdict, getVerdictState } = await import(
    "../verdict/service.ts"
  );
  const { getAiCollections } = await import("../db/collections.ts");

  send({ type: "tool", name: "verdict", status: "start" });
  const verdict = await generateVerdict({
    ctx,
    threadId: thread._id ?? null,
    onProgress: (stage) =>
      send({ type: "tool", name: "verdict", status: "start", stage }),
  });
  send({ type: "tool", name: "verdict", status: "end" });

  const state = await getVerdictState(ctx);
  const wire = serializeVerdict(verdict, state?.stale ?? false);
  send({ type: "artifact", artifact: "verdict", verdict: wire });

  // Persist a linked assistant message so history restores the card.
  const { chatMessages, chatThreads } = await getAiCollections();
  const now = new Date();
  const assistantDoc = {
    tenantId: ctx.tenantId,
    threadId: thread._id!,
    tenderId: ctx.tender.tenderId,
    role: "assistant" as const,
    content: "",
    status: "complete" as const,
    locale: ctx.locale,
    toolEvents: [{ name: "verdict", durationMs: 0, resultCount: null }],
    citations: [],
    verdictId: verdict._id ?? null,
    metrics: null,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await chatMessages.insertOne(assistantDoc as never);
  await chatThreads.updateOne(
    { _id: thread._id, tenantId: ctx.tenantId },
    { $set: { lastMessageAt: now, updatedAt: now }, $inc: { messageCount: 1 } },
  );
  send({
    type: "message",
    message: serializeChatMessage({
      ...assistantDoc,
      _id: inserted.insertedId,
    }),
  });
}
