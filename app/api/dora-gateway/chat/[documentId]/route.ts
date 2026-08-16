import { NextResponse } from "next/server";
import { z } from "zod";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import { buildDoraGraph } from "@/lib/ai/dora/graph";
import { streamDoraEditTurnResponse } from "@/lib/ai/dora/edit-turn";
import { ensureDocumentThread } from "@/lib/ai/dora/threads";
import { streamChatTurnResponse } from "@/lib/ai/agent/sse-turn";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight, withCors } from "@/lib/dora-gateway/cors";
import { isLikelyEditIntent } from "@/lib/dora-gateway/edit-v2";
import {
  doraEditEngineV2Enabled,
  getDoraSnapshot,
} from "@/lib/dora-gateway/snapshots";

/**
 * Editor-origin Dora chat: the same turn machinery as the in-app route
 * (app/api/workspace-documents/[documentId]/dora/chat), authenticated with a
 * gateway bearer instead of the session cookie, CORS-pinned to the editor
 * origins. Uses the SAME frozen thread key, so panel and app share history.
 */

const postSchema = z.object({
  message: z.string().min(1).max(4000),
  locale: z.enum(["en", "de"]).optional(),
  intent: z.enum(["auto", "chat", "edit"]).default("auto"),
  source: z.enum(["selection", "composer"]).default("composer"),
  snapshotId: z.string().uuid().optional(),
  clientContext: z
    .object({
      selectedText: z.string().max(4000).optional(),
      page: z.number().int().min(1).optional(),
      pageCount: z.number().int().min(1).optional(),
    })
    .optional(),
});

type RouteParams = { params: Promise<{ documentId: string }> };

export function OPTIONS(request: Request) {
  return handlePreflight(request);
}

export async function POST(request: Request, { params }: RouteParams) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503, headers: cors });
  }

  const { documentId } = await params;
  let auth;
  try {
    auth = await requireDoraGatewayAuth(request, documentId);
  } catch (error) {
    const status = error instanceof DoraGatewayAuthError ? error.status : 401;
    const message = error instanceof DoraGatewayAuthError ? error.message : "unauthorized";
    return NextResponse.json({ error: message }, { status, headers: cors });
  }

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400, headers: cors },
    );
  }

  const ctx = await buildDoraRunContext({
    companyContext: auth.companyContext,
    documentIdHex: documentId,
    locale: parsed.data.locale ?? "en",
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404, headers: cors });

  const thread = await ensureDocumentThread({
    tenantId: ctx.tenantId,
    documentId: ctx.document.documentId,
    userId: ctx.userId,
  });

  const useEditPath =
    doraEditEngineV2Enabled() &&
    (parsed.data.intent === "edit" ||
      (parsed.data.intent === "auto" && isLikelyEditIntent(parsed.data.message)));
  if (useEditPath) {
    if (!parsed.data.snapshotId) {
      return NextResponse.json(
        { error: "live_snapshot_required" },
        { status: 409, headers: cors },
      );
    }
    const snapshot = await getDoraSnapshot({
      snapshotId: parsed.data.snapshotId,
      tenantId: String(ctx.tenantId),
      documentId,
      userId: ctx.userId,
    });
    if (!snapshot || snapshot.editorKey !== ctx.document.activeEditorKey) {
      return NextResponse.json(
        { error: "snapshot_stale" },
        { status: 409, headers: cors },
      );
    }
    return withCors(
      request,
      streamDoraEditTurnResponse({
        ctx,
        thread,
        snapshot,
        message: parsed.data.message,
        source: parsed.data.source,
        request,
      }),
    );
  }

  const response = await streamChatTurnResponse({
    ctx,
    thread,
    body: { message: parsed.data.message },
    request,
    buildGraph: () => buildDoraGraph(ctx),
  });
  return withCors(request, response);
}
