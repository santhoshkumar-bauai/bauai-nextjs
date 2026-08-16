import { NextResponse } from "next/server";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";
import { storeDoraSnapshot } from "@/lib/dora-gateway/snapshots";

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

  try {
    const body = await request.json();
    if (body?.editorKey !== ctx.document.activeEditorKey) {
      return NextResponse.json({ error: "editor_revision_mismatch" }, { status: 409, headers: cors });
    }
    const snapshot = await storeDoraSnapshot({
      tenantId: String(ctx.tenantId),
      documentId,
      userId: ctx.userId,
      snapshot: body,
    });
    return NextResponse.json(
      {
        snapshotId: snapshot._id,
        snapshotHash: snapshot.snapshotHash,
        expiresAt: snapshot.expiresAt.toISOString(),
      },
      { headers: cors },
    );
  } catch (error) {
    const invalid = error instanceof Error && error.name === "ZodError";
    return NextResponse.json(
      { error: invalid ? "invalid_snapshot" : "failed" },
      { status: invalid ? 400 : 500, headers: cors },
    );
  }
}
