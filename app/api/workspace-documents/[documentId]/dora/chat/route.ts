import { NextResponse } from "next/server";
import { z } from "zod";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import { buildDoraGraph } from "@/lib/ai/dora/graph";
import { clearDocumentThread, ensureDocumentThread } from "@/lib/ai/dora/threads";
import { serializeChatMessage } from "@/lib/ai/agent/service";
import { streamChatTurnResponse } from "@/lib/ai/agent/sse-turn";
import { getAiCollections } from "@/lib/ai/db/collections";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { aiProviderConfigured } from "@/lib/ai/gateway/config";

/**
 * Dora chat for one workspace document. GET bootstraps the (company-shared)
 * document thread + history, POST streams one turn over SSE — Clara's SSE
 * turn with Dora's graph swapped in — DELETE clears the conversation.
 * No attachments and no commands in v1: the document IS the subject.
 */

const postSchema = z.object({
  message: z.string().min(1).max(4000),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId } = await params;
  const ctx = await buildDoraRunContext({
    companyContext: context,
    documentIdHex: documentId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thread = await ensureDocumentThread({
    tenantId: ctx.tenantId,
    documentId: ctx.document.documentId,
    userId: ctx.userId,
  });
  const { chatMessages } = await getAiCollections();
  const messages = await chatMessages
    .find({ tenantId: ctx.tenantId, threadId: thread._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  return NextResponse.json({
    thread: {
      id: String(thread._id),
      documentId,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt.toISOString(),
    },
    messages: messages.reverse().map(serializeChatMessage),
    verdicts: [],
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!aiProviderConfigured()) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }

  const { documentId } = await params;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const ctx = await buildDoraRunContext({
    companyContext: context,
    documentIdHex: documentId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const thread = await ensureDocumentThread({
    tenantId: ctx.tenantId,
    documentId: ctx.document.documentId,
    userId: ctx.userId,
  });

  return streamChatTurnResponse({
    ctx,
    thread,
    body: parsed.data,
    request,
    buildGraph: () => buildDoraGraph(ctx),
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId } = await params;
  const ctx = await buildDoraRunContext({
    companyContext: context,
    documentIdHex: documentId,
    locale: "en",
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await clearDocumentThread(ctx.tenantId, ctx.document.documentId);
  return NextResponse.json({ ok: true });
}
