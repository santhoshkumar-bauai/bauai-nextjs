import { randomUUID } from "node:crypto";

import type { ChatThreadDocument } from "../types.ts";
import { getAiCollections } from "../db/collections.ts";
import { bumpThread } from "../agent/threads.ts";
import { persistChatMessage, serializeChatMessage } from "../agent/service.ts";
import type { AgentSseEvent } from "../agent/wire.ts";
import type { DoraRunContext } from "./context.ts";
import type { StoredDoraSnapshot } from "../../dora-gateway/snapshot-schema.ts";
import {
  buildEditGrounding,
  editGroundingKind,
  planDoraEditTransaction,
} from "../../dora-gateway/edit-v2.ts";
import { recordEditTransactionState } from "../../dora-gateway/audit.ts";
import { resolveRole } from "../gateway/config.ts";

const HEARTBEAT_INTERVAL_MS = 25_000;
const EDIT_TIMEOUT_MS = 120_000;

function plannerFailureCode(error: unknown): string {
  if (!(error instanceof Error)) return "planner_failed";
  if (error.name === "ZodError") return "planner_schema_invalid";
  if (error.message.startsWith("invalid_edit_plan:")) {
    const reason = error.message.slice("invalid_edit_plan:".length);
    return /^[a-z0-9_:-]{1,120}$/i.test(reason)
      ? `invalid_edit_plan:${reason}`
      : "invalid_edit_plan";
  }
  if (error.message === "aborted") return "aborted";
  if (/rate.?limit/i.test(error.message)) return "rate_limited";
  if (/schema|response.?format|invalid.?argument|\b400\b/i.test(error.message)) {
    return "planner_schema_rejected";
  }
  if (/model.*(?:not found|not supported|unavailable)|\b404\b/i.test(error.message)) {
    return "planner_model_unavailable";
  }
  if (/api.?key|unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(error.message)) {
    return "planner_auth_failed";
  }
  if (/fetch failed|network|socket|econn|timeout/i.test(error.message)) {
    return "planner_network_failed";
  }
  return "planner_provider_failed";
}

function plannerFailureDetail(error: unknown, failureCode: string): string | null {
  if (!(error instanceof Error) || failureCode !== "planner_schema_rejected") return null;
  return error.message
    .replace(/https?:\/\/\S+/gi, "[provider-url]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[redacted-key]")
    .slice(0, 1_000);
}

async function recentConversation(
  ctx: DoraRunContext,
  thread: ChatThreadDocument,
): Promise<string> {
  const { chatMessages } = await getAiCollections();
  const messages = await chatMessages
    .find(
      { tenantId: ctx.tenantId, threadId: thread._id },
      { projection: { role: 1, content: 1, createdAt: 1 } },
    )
    .sort({ createdAt: -1 })
    .limit(8)
    .toArray();
  return messages
    .reverse()
    .filter((message) => message.content.trim())
    .map((message) => `${message.role.toUpperCase()}: ${message.content.slice(0, 2_000)}`)
    .join("\n");
}

/** Dedicated edit path: one structured planner call, deterministic compile,
 * explicit transaction event. Normal questions keep using the chat graph. */
export function streamDoraEditTurnResponse(input: {
  ctx: DoraRunContext;
  thread: ChatThreadDocument;
  snapshot: StoredDoraSnapshot;
  message: string;
  source: "selection" | "composer";
  request: Request;
}): Response {
  const encoder = new TextEncoder();
  const turnController = new AbortController();
  const timeout = setTimeout(() => turnController.abort(), EDIT_TIMEOUT_MS);
  input.request.signal.addEventListener("abort", () => turnController.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: AgentSseEvent) => {
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
        if (open) controller.enqueue(encoder.encode(": keep-alive\n\n"));
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
        const startedAt = Date.now();
        try {
          const historyPromise = recentConversation(input.ctx, input.thread);
          const userMessage = await persistChatMessage({
            tenantId: input.ctx.tenantId,
            threadId: input.thread._id!,
            tenderId: input.ctx.tender?.tenderId ?? null,
            role: "user",
            content: input.message,
            status: "complete",
            locale: input.ctx.locale,
            toolEvents: [],
            citations: [],
            verdictId: null,
            metrics: null,
          });
          send({
            type: "ready",
            threadId: String(input.thread._id),
            messageId: String(userMessage._id),
          });
          send({ type: "edit_status", stage: "reading" });
          const history = await historyPromise;
          const groundingKind = editGroundingKind(input.message);
          let grounding = "";
          if (groundingKind.company || (groundingKind.tender && input.ctx.tender)) {
            send({ type: "edit_status", stage: "researching" });
            grounding = await buildEditGrounding(input.ctx, input.message);
          }
          if (turnController.signal.aborted) throw new Error("aborted");
          send({ type: "edit_status", stage: "planning" });
          const transaction = await planDoraEditTransaction({
            ctx: input.ctx,
            snapshot: input.snapshot,
            userMessage: input.message,
            history,
            grounding,
            source: input.source,
          });
          await recordEditTransactionState({
            tenantId: input.ctx.tenantId,
            documentId: String(input.ctx.document.documentId),
            userId: input.ctx.userId,
            transactionId: transaction.transactionId,
            snapshotId: transaction.snapshotId,
            opId: null,
            type: null,
            surface: null,
            state: "planned",
            failureCode: null,
            schemaVersion: "dora-edit-v2",
            promptVersion: transaction.model.promptVersion,
            provider: transaction.model.provider,
            providerModel: transaction.model.providerModel,
            latencyMs: Date.now() - startedAt,
          });
          if (turnController.signal.aborted) throw new Error("aborted");
          send({ type: "edit_status", stage: "validating" });
          send({ type: "edit_transaction", transaction });

          const assistantMessage = await persistChatMessage({
            tenantId: input.ctx.tenantId,
            threadId: input.thread._id!,
            tenderId: input.ctx.tender?.tenderId ?? null,
            role: "assistant",
            content: transaction.assistantMessage,
            status: "complete",
            locale: input.ctx.locale,
            toolEvents: [
              { name: "plan_document_edits", durationMs: Date.now() - startedAt, resultCount: transaction.operations.length },
            ],
            citations: [],
            verdictId: null,
            metrics: {
              llmCalls: 1,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: Date.now() - startedAt,
            },
          });
          await bumpThread(input.ctx.tenantId, input.thread._id!, 2);
          send({ type: "edit_status", stage: "complete" });
          send({ type: "message", message: serializeChatMessage(assistantMessage) });
        } catch (error) {
          const failureCode = plannerFailureCode(error);
          const modelRef = resolveRole("dora");
          await recordEditTransactionState({
            tenantId: input.ctx.tenantId,
            documentId: String(input.ctx.document.documentId),
            userId: input.ctx.userId,
            transactionId: `planning-${randomUUID()}`,
            snapshotId: input.snapshot._id,
            opId: null,
            type: null,
            surface: null,
            state: "failed",
            failureCode,
            failureDetail: plannerFailureDetail(error, failureCode),
            schemaVersion: "dora-edit-v2",
            promptVersion: null,
            provider: modelRef.provider,
            providerModel: modelRef.model,
            latencyMs: Date.now() - startedAt,
          }).catch(() => undefined);
          send({
            type: "error",
            message:
              failureCode === "rate_limited"
                ? "rate_limited"
                : failureCode.startsWith("invalid_edit_plan") ||
                    failureCode === "planner_schema_invalid"
                  ? "invalid_edit_plan"
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
