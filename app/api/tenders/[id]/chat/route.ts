import { NextResponse } from "next/server";
import { z } from "zod";

import { buildAgentRunContext } from "@/lib/ai/agent/context";
import {
  runChatTurn,
  serializeChatMessage,
} from "@/lib/ai/agent/service";
import { clearThread, ensureThread } from "@/lib/ai/agent/threads";
import type { DoraSseEvent } from "@/lib/ai/agent/wire";
import { getAiCollections } from "@/lib/ai/db/collections";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

/**
 * Dora chat for one tender. GET bootstraps the thread + history, POST streams
 * one turn over SSE (fetch-reader on the client — SSE-over-POST), DELETE
 * clears the conversation. The agent runs inline; the BullMQ worker is not
 * involved.
 */

const HEARTBEAT_INTERVAL_MS = 25_000;
const TURN_TIMEOUT_MS = 120_000;

const postSchema = z.union([
  z.object({ message: z.string().min(1).max(4000) }),
  z.object({ command: z.literal("verdict") }),
]);

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const ctx = await buildAgentRunContext({
    companyContext: context,
    tenderIdHex: id,
    locale: "en",
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thread = await ensureThread({
    tenantId: ctx.tenantId,
    tenderId: ctx.tenderId,
    userId: ctx.userId,
  });
  const { chatMessages } = await getAiCollections();
  const messages = await chatMessages
    .find({ tenantId: ctx.tenantId, threadId: thread._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  // Attach the current verdict when any message references one.
  const { getVerdictState, serializeVerdict } = await import(
    "@/lib/ai/verdict/service"
  );
  const verdictState = await getVerdictState(ctx);

  return NextResponse.json({
    thread: {
      id: String(thread._id),
      tenderId: id,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt.toISOString(),
    },
    messages: messages.reverse().map(serializeChatMessage),
    verdicts: verdictState
      ? [serializeVerdict(verdictState.verdict, verdictState.stale)]
      : [],
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }

  const { id } = await params;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const ctx = await buildAgentRunContext({
    companyContext: context,
    tenderIdHex: id,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thread = await ensureThread({
    tenantId: ctx.tenantId,
    tenderId: ctx.tenderId,
    userId: ctx.userId,
  });

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

      const send = (event: DoraSseEvent) => {
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
          if ("command" in parsed.data) {
            // Verdict command: deterministic pipeline, not a model tool loop.
            const { generateVerdict, serializeVerdict, getVerdictState } =
              await import("@/lib/ai/verdict/service");
            const { getAiCollections } = await import("@/lib/ai/db/collections");

            send({ type: "tool", name: "verdict", status: "start" });
            const verdict = await generateVerdict({
              ctx,
              threadId: thread._id ?? null,
              onProgress: () => send({ type: "tool", name: "verdict", status: "start" }),
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
              tenderId: ctx.tenderId,
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
            return;
          }

          const result = await runChatTurn({
            ctx,
            threadId: thread._id!,
            userText: parsed.data.message,
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

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const ctx = await buildAgentRunContext({
    companyContext: context,
    tenderIdHex: id,
    locale: "en",
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await clearThread(ctx.tenantId, ctx.tenderId);
  return NextResponse.json({ ok: true });
}
