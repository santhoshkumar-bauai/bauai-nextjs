import { NextResponse } from "next/server";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";
import { storeSpreadsheetContext } from "@/lib/dora-gateway/spreadsheet-contexts";

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
  if (!ctx) return NextResponse.json({ error: "not_found" }, { status: 404, headers: cors });
  if (ctx.document.documentType !== "cell") {
    return NextResponse.json({ error: "spreadsheet_required" }, { status: 409, headers: cors });
  }

  try {
    const body = await request.json();
    if (body?.editorKey !== ctx.document.activeEditorKey) {
      return NextResponse.json(
        { error: "editor_revision_mismatch" },
        { status: 409, headers: cors },
      );
    }
    const stored = await storeSpreadsheetContext({
      tenantId: String(ctx.tenantId),
      documentId,
      userId: ctx.userId,
      context: body,
    });
    return NextResponse.json(
      {
        contextId: stored._id,
        contextHash: stored.contextHash,
        workbookRevision: stored.workbookRevision,
        expiresAt: stored.expiresAt.toISOString(),
      },
      { headers: cors },
    );
  } catch (error) {
    const invalid = error instanceof Error && error.name === "ZodError";
    return NextResponse.json(
      { error: invalid ? "invalid_spreadsheet_context" : "failed" },
      { status: invalid ? 400 : 500, headers: cors },
    );
  }
}
