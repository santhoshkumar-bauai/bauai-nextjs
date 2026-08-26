import { NextResponse } from "next/server";
import { z } from "zod";

import { buildAgentRunContext } from "@/lib/ai/agent/context";
import { serializeChatMessage } from "@/lib/ai/agent/service";
import { streamChatTurnResponse } from "@/lib/ai/agent/sse-turn";
import { clearThread, ensureTenderThread } from "@/lib/ai/agent/threads";
import { getAiCollections } from "@/lib/ai/db/collections";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { aiProviderConfigured } from "@/lib/ai/gateway/config";

/**
 * Clara chat for one tender. GET bootstraps the thread + history, POST streams
 * one turn over SSE (fetch-reader on the client — SSE-over-POST), DELETE
 * clears the conversation. The agent runs inline; the BullMQ worker is not
 * involved.
 */

const postSchema = z.union([
  z
    .object({
      message: z.string().max(4000).default(""),
      attachmentIds: z.array(z.string().length(24)).max(4).optional(),
    })
    .refine(
      (data) => data.message.trim().length > 0 || (data.attachmentIds?.length ?? 0) > 0,
      { message: "Message or attachment required" },
    ),
  z.object({ command: z.literal("verdict") }),
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const ctx = await buildAgentRunContext({
    companyContext: context,
    tenderIdHex: id,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thread = await ensureTenderThread({
    tenantId: ctx.tenantId,
    tenderId: ctx.tender.tenderId,
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
  if (!aiProviderConfigured()) {
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

  const thread = await ensureTenderThread({
    tenantId: ctx.tenantId,
    tenderId: ctx.tender.tenderId,
    userId: ctx.userId,
  });

  return streamChatTurnResponse({ ctx, thread, body: parsed.data, request });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const ctx = await buildAgentRunContext({
    companyContext: context,
    tenderIdHex: id,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await clearThread(ctx.tenantId, ctx.tender.tenderId);
  return NextResponse.json({ ok: true });
}
