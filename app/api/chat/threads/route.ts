import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";

import {
  createGlobalThread,
  ensureTenderThread,
  listThreads,
} from "@/lib/ai/agent/threads";
import type { WireThreadSummary } from "@/lib/ai/agent/wire";
import type { ChatThreadDocument } from "@/lib/ai/types";
import { getCompanyContext } from "@/lib/company/context";
import { mongoDatabase } from "@/lib/db/mongodb";
import { forCompanyContext } from "@/lib/ai/tenant/repository";

/**
 * Clara chat sessions. GET lists the caller's sidebar (own global threads +
 * the company's active tender threads); POST creates a global thread, or —
 * with a tenderId — ensures and returns the company's tender thread (the
 * `/chat?tender=` deep-link boot, one round trip).
 */

const postSchema = z.object({
  tenderId: z.string().length(24).optional(),
});

function summarize(
  thread: ChatThreadDocument,
  tenderTitles: Map<string, string | null>,
): WireThreadSummary {
  return {
    id: String(thread._id),
    kind: thread.kind,
    title: thread.title,
    tenderId: thread.tenderId ? String(thread.tenderId) : null,
    tenderTitle: thread.tenderId
      ? (tenderTitles.get(String(thread.tenderId)) ?? null)
      : null,
    messageCount: thread.messageCount,
    lastMessageAt: thread.lastMessageAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
  };
}

export async function GET() {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const tenantId = forCompanyContext(context).value;
  const threads = await listThreads({ tenantId, userId: context.userId });

  const tenderIds = threads
    .map((thread) => thread.tenderId)
    .filter((id): id is ObjectId => id !== null);
  const tenderTitles = new Map<string, string | null>();
  if (tenderIds.length > 0) {
    const tenders = await mongoDatabase
      .collection<{ _id: ObjectId; title?: string | null }>("tenders")
      .find({ _id: { $in: tenderIds } }, { projection: { title: 1 } })
      .toArray();
    for (const tender of tenders) {
      tenderTitles.set(String(tender._id), tender.title ?? null);
    }
  }

  return NextResponse.json({
    threads: threads.map((thread) => summarize(thread, tenderTitles)),
  });
}

export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = postSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const tenantId = forCompanyContext(context).value;

  let thread: ChatThreadDocument;
  if (parsed.data.tenderId) {
    // Deep link from a tender: validate the tender exists and is visible
    // before touching the (company-shared) tender thread.
    const { resolveVisibleTender } = await import("@/lib/ai/agent/context");
    const scope = await resolveVisibleTender(parsed.data.tenderId);
    if (!scope) return NextResponse.json({ error: "Not found" }, { status: 404 });
    thread = await ensureTenderThread({
      tenantId,
      tenderId: scope.tenderId,
      userId: context.userId,
    });
  } else {
    thread = await createGlobalThread({ tenantId, userId: context.userId });
  }

  return NextResponse.json(
    { thread: summarize(thread, new Map()) },
    { status: 201 },
  );
}
