import { NextResponse } from "next/server";

import { forcesaveAndWait } from "@/lib/ai/dora/forcesave";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";

type RouteParams = { params: Promise<{ documentId: string }> };

export function OPTIONS(request: Request) {
  return handlePreflight(request);
}

/** Debounced client checkpoint after a Dora transaction is fully reviewed. */
export async function POST(request: Request, { params }: RouteParams) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  const { documentId } = await params;
  try {
    await requireDoraGatewayAuth(request, documentId);
  } catch (error) {
    const status = error instanceof DoraGatewayAuthError ? error.status : 401;
    const message = error instanceof DoraGatewayAuthError ? error.message : "unauthorized";
    return NextResponse.json({ error: message }, { status, headers: cors });
  }
  const result = await forcesaveAndWait({ documentId });
  return NextResponse.json(result, { headers: cors });
}
