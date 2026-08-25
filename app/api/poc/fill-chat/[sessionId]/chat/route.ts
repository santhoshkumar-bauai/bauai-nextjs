import { NextResponse } from "next/server";
import { z } from "zod";

import { serializeChatMessage } from "@/lib/ai/agent/service";
import { streamChatTurnResponse } from "@/lib/ai/agent/sse-turn";
import { getAiCollections } from "@/lib/ai/db/collections";
import { buildFillAgentRunContext } from "@/lib/ai/fill-agent/context";
import { buildFillAgentGraph } from "@/lib/ai/fill-agent/graph";
import { ensureFillSessionThread } from "@/lib/ai/fill-agent/threads";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

/**
 * One fill-agent chat turn over SSE — Clara's SSE turn runner with the fill
 * agent's graph swapped in (the Dora chat route pattern). The graph carries
 * its own recursionLimit; see lib/ai/fill-agent/graph.ts.
 */

const postSchema = z.object({
  message: z.string().min(1).max(4000),
});

/** Bootstrap for the chat hook: history for this session's thread. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId } = await params;
  const ctx = await buildFillAgentRunContext({
    companyContext: context,
    sessionIdHex: sessionId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thread = await ensureFillSessionThread({
    tenantId: ctx.tenantId,
    sessionId: ctx.session._id!,
    userId: ctx.userId,
  });
  const { chatMessages } = await getAiCollections();
  const messages = await chatMessages
    .find({ tenantId: ctx.tenantId, threadId: thread._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  return NextResponse.json({
    messages: messages.reverse().map(serializeChatMessage),
    verdicts: [],
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (
    !process.env.GEMINI_API_KEY &&
    !process.env.OPENAI_API_KEY &&
    !process.env.ANTHROPIC_API_KEY
  ) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }

  const { sessionId } = await params;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const ctx = await buildFillAgentRunContext({
    companyContext: context,
    sessionIdHex: sessionId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thread = await ensureFillSessionThread({
    tenantId: ctx.tenantId,
    sessionId: ctx.session._id!,
    userId: ctx.userId,
  });

  return streamChatTurnResponse({
    ctx,
    thread,
    body: parsed.data,
    request,
    buildGraph: () => buildFillAgentGraph(ctx),
  });
}
