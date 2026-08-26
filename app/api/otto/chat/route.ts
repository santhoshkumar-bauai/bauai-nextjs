import { NextResponse } from "next/server";
import { z } from "zod";

import { serializeChatMessage } from "@/lib/ai/agent/service";
import { streamChatTurnResponse } from "@/lib/ai/agent/sse-turn";
import { getAiCollections } from "@/lib/ai/db/collections";
import { buildOttoRunContext } from "@/lib/ai/otto/context";
import { buildOttoGraph } from "@/lib/ai/otto/graph";
import {
  readOttoGraphState,
  readOttoSummary,
  syncOttoProfileState,
} from "@/lib/ai/otto/service";
import { ensureOnboardingThread, resetOnboardingThread } from "@/lib/ai/otto/threads";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { PROFILE_CHOICES } from "@/lib/ai/otto/wire";
import { aiProviderConfigured } from "@/lib/ai/gateway/config";

/**
 * Otto, the onboarding guide. GET bootstraps the user's private thread, its
 * history and the current graph state; POST streams one turn over SSE — the
 * shared SSE turn with Otto's graph swapped in, plus `state` events so the
 * progress checklist updates live.
 *
 * `getCompanyContext()` is the auth gate: no session, unverified email, or no
 * active membership means no agent. Anonymous users get nothing.
 */

const postSchema = z.object({
  message: z.string().min(1).max(4000),
  /**
   * Readables published by mounted components — current route, whether the
   * current target is on screen. Untrusted CONTEXT, never authority: it is
   * rendered into the prompt as "what the user reports seeing" and no decision
   * is taken from it. Milestone completion still comes from the database.
   */
  clientContext: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ctx = buildOttoRunContext({
    companyContext: context,
    locale: resolveRequestLocale(request),
  });

  const thread = await ensureOnboardingThread({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  });

  const { chatMessages } = await getAiCollections();
  const [messages, graphState, summary] = await Promise.all([
    chatMessages
      .find({ tenantId: ctx.tenantId, threadId: thread._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray(),
    readOttoGraphState(ctx),
    readOttoSummary(ctx),
  ]);

  // Bootstrap is the safe point to reconcile the durable mirror: the previous
  // turn's checkpoint is fully written by now.
  if (graphState) {
    await syncOttoProfileState({ userId: ctx.userId, graphState });
  }

  return NextResponse.json({
    thread: {
      id: String(thread._id),
      messageCount: thread.messageCount,
      lastMessageAt: thread.lastMessageAt.toISOString(),
    },
    messages: messages.reverse().map(serializeChatMessage),
    // Present so the client can reuse the shared chat hook unchanged.
    verdicts: [],
    state: graphState,
    summary,
    // The choice ids the UI renders as buttons. Sent from here so the client
    // never has to know the profile question vocabulary.
    profileChoices: PROFILE_CHOICES,
  });
}

export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (
    !aiProviderConfigured()
  ) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const ctx = buildOttoRunContext({
    companyContext: context,
    locale: resolveRequestLocale(request),
    clientContext: parsed.data.clientContext,
  });

  const thread = await ensureOnboardingThread({
    tenantId: ctx.tenantId,
    userId: ctx.userId,
  });

  // The profile mirror is NOT updated here: this returns as soon as the
  // stream is constructed, long before the graph has written its checkpoint,
  // so anything read now would be a turn stale. GET does the mirroring, and
  // the client re-bootstraps when a turn ends.
  return streamChatTurnResponse({
    ctx,
    thread,
    body: parsed.data,
    request,
    buildGraph: () => buildOttoGraph(ctx),
    streamState: true,
  });
}

/** Start onboarding over: clears the conversation and the graph checkpoint. */
export async function DELETE() {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const ctx = buildOttoRunContext({ companyContext: context, locale: "en" });
  await resetOnboardingThread({ tenantId: ctx.tenantId, userId: ctx.userId });
  return NextResponse.json({ ok: true });
}
