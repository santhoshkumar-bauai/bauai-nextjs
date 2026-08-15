import { NextResponse } from "next/server";
import { z } from "zod";

import { recordEditOpState } from "@/lib/dora-gateway/audit";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";
import { forCompanyContext } from "@/lib/ai/tenant/repository";

/** Panel → gateway: terminal edit-op state reports (fire-and-forget audit). */

const postSchema = z.object({
  opId: z.string().min(8).max(64),
  type: z.enum(["replace_text", "insert_after", "comment"]),
  state: z.enum(["applied", "accepted", "rejected", "dismissed", "stale", "failed"]),
  failureCode: z.string().max(64).optional(),
});

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

  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: cors });
  }

  await recordEditOpState({
    tenantId: forCompanyContext(auth.companyContext).value,
    documentId,
    userId: auth.companyContext.userId,
    opId: parsed.data.opId,
    type: parsed.data.type,
    state: parsed.data.state,
    failureCode: parsed.data.failureCode ?? null,
  });
  return NextResponse.json({ ok: true }, { headers: cors });
}
