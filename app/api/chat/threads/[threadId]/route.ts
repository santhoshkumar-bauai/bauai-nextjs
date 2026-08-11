import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  buildAgentRunContext,
  buildGlobalAgentRunContext,
  type AgentRunContext,
  type TenderAgentRunContext,
} from "@/lib/ai/agent/context";
import { serializeChatMessage } from "@/lib/ai/agent/service";
import { streamChatTurnResponse } from "@/lib/ai/agent/sse-turn";
import {
  deleteThread,
  getOwnedThread,
  renameThread,
} from "@/lib/ai/agent/threads";
import type { WireVerdict } from "@/lib/ai/agent/wire";
import { getAiCollections } from "@/lib/ai/db/collections";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import type { ChatThreadDocument } from "@/lib/ai/types";
import { getCompanyContext, type CompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

/**
 * One Clara chat session, addressed by thread id — the full-page chat's API.
 * Serves BOTH kinds: global threads (owner-only) and tender threads (any
 * company member; same threadKey as the tender-dialog route, so both surfaces
 * continue one conversation). GET = history, POST = one SSE turn,
 * PATCH = rename (global only), DELETE = delete/clear.
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

const patchSchema = z.object({ title: z.string().min(1).max(80) });

async function loadOwnedThread(
  context: CompanyContext,
  threadIdHex: string,
): Promise<ChatThreadDocument | null> {
  if (!ObjectId.isValid(threadIdHex)) return null;
  const thread = await getOwnedThread({
    tenantId: forCompanyContext(context).value,
    userId: context.userId,
    threadId: new ObjectId(threadIdHex),
  });
  // This route is Clara's; Dora document threads have their own endpoint under
  // /api/workspace-documents and must not run with Clara's graph or tools.
  if (thread && thread.agent !== "clara") return null;
  return thread;
}

/** Context for the thread's mode; null when a tender thread's tender is gone. */
async function contextForThread(
  context: CompanyContext,
  thread: ChatThreadDocument,
  locale: "en" | "de",
): Promise<AgentRunContext | null> {
  if (thread.kind === "global") {
    return buildGlobalAgentRunContext({ companyContext: context, locale });
  }
  return buildAgentRunContext({
    companyContext: context,
    tenderIdHex: String(thread.tenderId),
    locale,
  });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { threadId } = await params;
  const thread = await loadOwnedThread(context, threadId);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { chatMessages } = await getAiCollections();
  const messages = await chatMessages
    .find({ tenantId: thread.tenantId, threadId: thread._id })
    .sort({ createdAt: -1 })
    .limit(50)
    .toArray();

  // Tender threads restore their verdict card; tolerate a since-hidden tender.
  let verdicts: WireVerdict[] = [];
  if (thread.kind === "tender") {
    const ctx = await contextForThread(context, thread, resolveRequestLocale(request));
    if (ctx?.tender) {
      const { getVerdictState, serializeVerdict } = await import(
        "@/lib/ai/verdict/service"
      );
      const state = await getVerdictState(ctx as TenderAgentRunContext);
      if (state) verdicts = [serializeVerdict(state.verdict, state.stale)];
    }
  }

  return NextResponse.json({
    thread: {
      id: String(thread._id),
      kind: thread.kind,
      tenderId: thread.tenderId ? String(thread.tenderId) : null,
      title: thread.title,
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt.toISOString(),
    },
    messages: messages.reverse().map(serializeChatMessage),
    verdicts,
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }

  const { threadId } = await params;
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const thread = await loadOwnedThread(context, threadId);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const ctx = await contextForThread(context, thread, resolveRequestLocale(request));
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return streamChatTurnResponse({ ctx, thread, body: parsed.data, request });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { threadId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const thread = await loadOwnedThread(context, threadId);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (thread.kind !== "global") {
    // Tender threads show the tender title; renaming them is meaningless.
    return NextResponse.json({ error: "Not renameable" }, { status: 400 });
  }

  await renameThread(thread.tenantId, thread._id!, parsed.data.title.trim());
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ threadId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { threadId } = await params;
  const thread = await loadOwnedThread(context, threadId);
  if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await deleteThread(thread);
  return NextResponse.json({ ok: true });
}
