import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";

import { serializeChatMessage } from "@/lib/ai/agent/service";
import { getAiCollections } from "@/lib/ai/db/collections";
import {
  deleteFillSession,
  getFillSession,
  serializeFillSession,
} from "@/lib/ai/fill-agent/store";
import { getSandboxClient } from "@/lib/ai/fill-agent/sandbox-client";
import {
  fillSessionThreadKey,
  purgeFillSessionThread,
} from "@/lib/ai/fill-agent/threads";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";
import { deleteObject } from "@/lib/storage/s3";

/** One fill session: state + chat history (GET), full teardown (DELETE). */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId } = await params;
  if (!ObjectId.isValid(sessionId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tenantId = forCompanyContext(context).value;
  const session = await getFillSession(tenantId, new ObjectId(sessionId));
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { chatThreads, chatMessages } = await getAiCollections();
  const thread = await chatThreads.findOne({
    tenantId,
    threadKey: fillSessionThreadKey(tenantId, session._id!),
  });
  const messages = thread
    ? await chatMessages
        .find({ tenantId, threadId: thread._id })
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray()
    : [];

  const rawCursor = new URL(request.url).searchParams.get("activityAfter");
  const activityAfter = rawCursor == null ? undefined : Number.parseInt(rawCursor, 10);
  return NextResponse.json({
    session: serializeFillSession(session, {
      ...(Number.isFinite(activityAfter) ? { activityAfter } : {}),
    }),
    messages: messages.reverse().map(serializeChatMessage),
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId } = await params;
  if (!ObjectId.isValid(sessionId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const tenantId = forCompanyContext(context).value;
  const id = new ObjectId(sessionId);
  const session = await getFillSession(tenantId, id);
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Best-effort external cleanup; the Mongo delete is the operation of record.
  if (session.sandboxSessionId) {
    await getSandboxClient()
      .deleteSession(session.sandboxSessionId)
      .catch(() => {});
  }
  // Document-bound sessions REFERENCE the workspace version's object — it
  // belongs to the document, never to this session.
  if (!session.documentId) {
    await deleteObject(session.source.s3Key).catch(() => {});
  }
  if (session.output) await deleteObject(session.output.s3Key).catch(() => {});
  await purgeFillSessionThread(tenantId, id);
  await deleteFillSession(tenantId, id);

  return NextResponse.json({ ok: true });
}
