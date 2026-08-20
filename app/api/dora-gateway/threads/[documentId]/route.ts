import { NextResponse } from "next/server";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import { startNewDocumentThread } from "@/lib/ai/dora/threads";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";

/**
 * "New chat" for the editor panel: opens the next-generation thread for the
 * document (idempotent — an active-but-empty conversation is reused, so the
 * button can never pile up blank threads).
 */

type RouteParams = { params: Promise<{ documentId: string }> };

export function OPTIONS(request: Request) {
  return handlePreflight(request);
}

export async function POST(request: Request, { params }: RouteParams) {
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

  const thread = await startNewDocumentThread({
    tenantId: ctx.tenantId,
    documentId: ctx.document.documentId,
    userId: ctx.userId,
  });
  return NextResponse.json(
    {
      thread: {
        id: String(thread._id),
        documentId,
        messageCount: thread.messageCount,
        lastMessageAt: thread.lastMessageAt.toISOString(),
      },
    },
    { headers: cors },
  );
}
