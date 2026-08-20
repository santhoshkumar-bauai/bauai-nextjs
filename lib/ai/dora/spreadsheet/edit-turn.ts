import type { StoredSpreadsheetContext } from "@/lib/dora-gateway/spreadsheet-schema";
import { recordEditTransactionState } from "@/lib/dora-gateway/audit";

import { persistChatMessage, serializeChatMessage } from "../../agent/service";
import { bumpThread } from "../../agent/threads";
import type { AgentSseEvent } from "../../agent/wire";
import type { ChatThreadDocument } from "../../types";
import type { DoraRunContext } from "../context";
import { planSpreadsheetChangeSet } from "./edit";

const HEARTBEAT_MS = 25_000;

export function streamDoraSpreadsheetEditTurnResponse(input: {
  ctx: DoraRunContext;
  thread: ChatThreadDocument;
  context: StoredSpreadsheetContext;
  message: string;
  request: Request;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: AgentSseEvent) => {
        if (open) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const heartbeat = setInterval(() => {
        if (open) controller.enqueue(encoder.encode(": keep-alive\n\n"));
      }, HEARTBEAT_MS);
      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      input.request.signal.addEventListener("abort", close, { once: true });
      void (async () => {
        const startedAt = Date.now();
        try {
          const user = await persistChatMessage({
            tenantId: input.ctx.tenantId, threadId: input.thread._id!,
            tenderId: input.ctx.tender?.tenderId ?? null, role: "user",
            content: input.message, status: "complete", locale: input.ctx.locale,
            toolEvents: [], citations: [], verdictId: null, metrics: null,
          });
          send({ type: "ready", threadId: String(input.thread._id), messageId: String(user._id) });
          send({ type: "edit_status", stage: "planning" });
          const changeSet = await planSpreadsheetChangeSet({
            ctx: input.ctx, context: input.context, message: input.message,
          });
          await recordEditTransactionState({
            tenantId: input.ctx.tenantId,
            documentId: String(input.ctx.document.documentId),
            userId: input.ctx.userId,
            transactionId: changeSet.changeSetId,
            snapshotId: changeSet.contextId,
            opId: null,
            type: null,
            surface: null,
            state: "planned",
            failureCode: null,
            schemaVersion: "dora-spreadsheet-v1",
            promptVersion: changeSet.model.promptVersion,
            provider: changeSet.model.provider,
            providerModel: changeSet.model.providerModel,
            latencyMs: Date.now() - startedAt,
            tier: "plan",
            mode: "review",
          });
          const assistant = await persistChatMessage({
            tenantId: input.ctx.tenantId, threadId: input.thread._id!,
            tenderId: input.ctx.tender?.tenderId ?? null, role: "assistant",
            content: `${changeSet.summary}\n\nReview the proposed cell changes below, then choose Apply or Cancel.`,
            status: "complete", locale: input.ctx.locale,
            toolEvents: [{ name: "plan_spreadsheet_changes", durationMs: Date.now() - startedAt, resultCount: changeSet.operations.length }],
            citations: [], verdictId: null,
            metrics: { llmCalls: 1, inputTokens: 0, outputTokens: 0, durationMs: Date.now() - startedAt },
          });
          await bumpThread(input.ctx.tenantId, input.thread._id!, 2);
          send({ type: "message", message: serializeChatMessage(assistant) });
          send({ type: "spreadsheet_change_set", changeSet });
        } catch (error) {
          const message = error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message)
            ? error.message : "spreadsheet_edit_failed";
          send({ type: "error", message });
        } finally { close(); }
      })();
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform" },
  });
}
