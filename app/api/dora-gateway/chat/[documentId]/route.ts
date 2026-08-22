import { NextResponse } from "next/server";
import { ObjectId } from "mongodb";
import { z } from "zod";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import { buildDoraGraph } from "@/lib/ai/dora/graph";
import { buildPdfTurnMedia } from "@/lib/ai/dora/pdf/turn-media";
import { buildDoraSpreadsheetGraph } from "@/lib/ai/dora/spreadsheet/graph";
import { streamDoraSpreadsheetEditTurnResponse } from "@/lib/ai/dora/spreadsheet/edit-turn";
import { streamDoraEditTurnResponse } from "@/lib/ai/dora/edit-turn";
import { streamDoraEditStreamResponse } from "@/lib/ai/dora/edit-stream-turn";
import { ensureDocumentThread } from "@/lib/ai/dora/threads";
import { streamChatTurnResponse } from "@/lib/ai/agent/sse-turn";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight, withCors } from "@/lib/dora-gateway/cors";
import { isLikelyEditIntent } from "@/lib/dora-gateway/edit-v2";
import { getSpreadsheetContext } from "@/lib/dora-gateway/spreadsheet-contexts";
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
  /** Delivery tier: "stream" = single-point streaming edit (dora_fast, token
   * deltas into the document), "plan" = validated V2 transaction, "auto" =
   * server decides (stream only when the invocation surface qualifies). */
  tier: z.enum(["auto", "stream", "plan"]).default("auto"),
  /** Quick-action key from the invocation surface (rewrite/shorten/…). */
  action: z.string().max(40).optional(),
  /** Selected chat (panel switcher); absent = the active conversation. */
  threadId: z.string().regex(/^[0-9a-f]{24}$/i).optional(),
  snapshotId: z.string().uuid().optional(),
  contextId: z.string().uuid().optional(),
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
    threadId: parsed.data.threadId ? new ObjectId(parsed.data.threadId) : null,
  });

  // Spreadsheet turns always use the bounded, bearer-bound live context
  // packet. Read-only questions use the spreadsheet graph; mutation requests
  // use a separate structured planner and are returned as preview-only change
  // sets. The editor remains the sole, user-approved mutation boundary.
  if (ctx.document.documentType === "cell") {
    if (process.env.DORA_SPREADSHEET_ENABLED === "false") {
      return NextResponse.json(
        { error: "spreadsheet_dora_disabled" },
        { status: 409, headers: cors },
      );
    }
    if (parsed.data.tier === "stream") {
      return NextResponse.json(
        { error: "spreadsheet_streaming_writes_not_supported" },
        { status: 409, headers: cors },
      );
    }
    const useSpreadsheetEditPath =
      parsed.data.tier === "plan" ||
      parsed.data.intent === "edit" ||
      (parsed.data.intent === "auto" &&
        (isLikelyEditIntent(parsed.data.message) ||
          /\b(?:add|calculate|change|clear|copy|edit|fill|fix|insert|replace|set|update|write)\b/i
            .test(parsed.data.message)));
    const spreadsheetContext = parsed.data.contextId
      ? await getSpreadsheetContext({
          contextId: parsed.data.contextId,
          tenantId: String(ctx.tenantId),
          documentId,
          userId: ctx.userId,
        })
      : null;
    if (parsed.data.contextId && !spreadsheetContext) {
      return NextResponse.json(
        { error: "spreadsheet_context_stale" },
        { status: 409, headers: cors },
      );
    }
    if (spreadsheetContext?.editorKey !== ctx.document.activeEditorKey) {
      return NextResponse.json(
        { error: "spreadsheet_context_stale" },
        { status: 409, headers: cors },
      );
    }
    if (useSpreadsheetEditPath) {
      if (process.env.DORA_SPREADSHEET_WRITES_ENABLED === "false") {
        return NextResponse.json(
          { error: "spreadsheet_writes_not_enabled" },
          { status: 409, headers: cors },
        );
      }
      if (!spreadsheetContext) {
        return NextResponse.json(
          { error: "live_spreadsheet_context_required" },
          { status: 409, headers: cors },
        );
      }
      return withCors(
        request,
        streamDoraSpreadsheetEditTurnResponse({
          ctx,
          thread,
          context: spreadsheetContext,
          message: parsed.data.message,
          request,
        }),
      );
    }
    const response = await streamChatTurnResponse({
      ctx,
      thread,
      body: { message: parsed.data.message },
      request,
      buildGraph: () => buildDoraSpreadsheetGraph(ctx, spreadsheetContext),
    });
    return withCors(request, response);
  }

  // PDFs are read-only to Dora: the PDF editor exposes no API to set a form
  // field's value, and body text cannot be rewritten without reflow damage.
  // Questions, the fill plan and field navigation only — every write goes
  // through the reviewed copy-generation flow instead.
  if (ctx.document.documentType === "pdf") {
    if (process.env.DORA_PDF_ENABLED === "false") {
      return NextResponse.json({ error: "pdf_dora_disabled" }, { status: 409, headers: cors });
    }
    if (parsed.data.tier === "stream") {
      return NextResponse.json(
        { error: "pdf_streaming_writes_not_supported" },
        { status: 409, headers: cors },
      );
    }
    const response = await streamChatTurnResponse({
      ctx,
      thread,
      body: { message: parsed.data.message },
      request,
      // A scanned PDF has no text to read, so the file itself rides in the
      // turn and the model reads the pages.
      extraContent: await buildPdfTurnMedia(ctx),
      buildGraph: () => buildDoraGraph(ctx),
    });
    return withCors(request, response);
  }

  // Stream tier: single-insertion-point edits stream token deltas into the
  // document (dora_fast). The client declares the tier from its invocation
  // surface; "stream" is only honored with a live snapshot, like the planner.
  // V2 is the WORD snapshot/range engine; without the documentType guard every
  // non-spreadsheet document fell into it and 409'd on live_snapshot_required.
  const v2 = doraEditEngineV2Enabled() && ctx.document.documentType === "word";
  const useStreamPath = v2 && parsed.data.tier === "stream";
  const useEditPath =
    v2 &&
    !useStreamPath &&
    (parsed.data.tier === "plan" ||
      parsed.data.intent === "edit" ||
      (parsed.data.intent === "auto" && isLikelyEditIntent(parsed.data.message)));
  if (useStreamPath || useEditPath) {
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
    if (useStreamPath) {
      return withCors(
        request,
        streamDoraEditStreamResponse({
          ctx,
          thread,
          snapshot,
          message: parsed.data.message,
          action: parsed.data.action,
          source: parsed.data.source,
          request,
        }),
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
