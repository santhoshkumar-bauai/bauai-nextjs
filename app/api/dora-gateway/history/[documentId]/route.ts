import { NextResponse } from "next/server";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import { ensureDocumentThread } from "@/lib/ai/dora/threads";
import { serializeChatMessage } from "@/lib/ai/agent/service";
import { getAiCollections } from "@/lib/ai/db/collections";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";

/** History replay for the editor panel — mirror of the in-app chat GET. */

type RouteParams = { params: Promise<{ documentId: string }> };

export function OPTIONS(request: Request) {
  return handlePreflight(request);
}

export async function GET(request: Request, { params }: RouteParams) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });

  const { documentId } = await params;
  let auth;
  try {
    auth = await requireDoraGatewayAuth(request, documentId);
  } catch (error) {
    const status = error instanceof DoraGatewayAuthError ? error.status : 401;
    const message = error instanceof DoraGatewayAuthError ? error.message : "unauthorized";
    return NextResponse.json({ error: message }, { status, headers: cors });
  }

  const ctx = await buildDoraRunContext({
    companyContext: auth.companyContext,
    documentIdHex: documentId,
    locale: "en",
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404, headers: cors });

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

  return NextResponse.json(
    {
      thread: {
        id: String(thread._id),
        documentId,
        messageCount: thread.messageCount,
        lastMessageAt: thread.lastMessageAt.toISOString(),
      },
      messages: messages.reverse().map(serializeChatMessage),
    },
    { headers: cors },
  );
}
