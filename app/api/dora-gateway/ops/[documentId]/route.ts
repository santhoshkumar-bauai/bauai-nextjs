import { NextResponse } from "next/server";
import { z } from "zod";

import {
  recordEditOpState,
  recordEditTransactionState,
} from "@/lib/dora-gateway/audit";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";
import { forCompanyContext } from "@/lib/ai/tenant/repository";

/** Panel → gateway: terminal edit-op state reports (fire-and-forget audit). */

const v1Schema = z.object({
  version: z.literal(1).optional(),
  opId: z.string().min(8).max(64),
  type: z.enum(["replace_text", "insert_after", "comment"]),
  state: z.enum(["applied", "accepted", "rejected", "dismissed", "stale", "failed"]),
  failureCode: z.string().max(64).optional(),
});

const v2Schema = z.object({
  version: z.literal(2),
  transactionId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  opId: z.string().uuid().optional(),
  type: z
    .enum([
      "replace_range",
      "insert_fragment",
      "delete_range",
      "format_text",
      "format_blocks",
      "update_table",
      "set_content_control",
      "comment",
    ])
    .optional(),
  surface: z
    .enum([
      "body",
      "header",
      "footer",
      "footnote",
      "endnote",
      "table_cell",
      "content_control",
      "text_box",
    ])
    .optional(),
  state: z.enum([
    "planned",
    "applying",
    "applied",
    "accepted",
    "rejected",
    "stale",
    "rolled_back",
    "failed",
  ]),
  failureCode: z.string().max(80).optional(),
  promptVersion: z.string().max(80).optional(),
  provider: z.string().max(40).optional(),
  providerModel: z.string().max(120).optional(),
  latencyMs: z.number().int().min(0).max(3_600_000).optional(),
});

const postSchema = z.union([v2Schema, v1Schema]);

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

  const tenantId = forCompanyContext(auth.companyContext).value;
  if (parsed.data.version === 2) {
    await recordEditTransactionState({
      tenantId,
      documentId,
      userId: auth.companyContext.userId,
      transactionId: parsed.data.transactionId,
      snapshotId: parsed.data.snapshotId,
      opId: parsed.data.opId ?? null,
      type: parsed.data.type ?? null,
      surface: parsed.data.surface ?? null,
      state: parsed.data.state,
      failureCode: parsed.data.failureCode ?? null,
      schemaVersion: "dora-edit-v2",
      promptVersion: parsed.data.promptVersion ?? null,
      provider: parsed.data.provider ?? null,
      providerModel: parsed.data.providerModel ?? null,
      latencyMs: parsed.data.latencyMs ?? null,
    });
  } else {
    await recordEditOpState({
      tenantId,
      documentId,
      userId: auth.companyContext.userId,
      opId: parsed.data.opId,
      type: parsed.data.type,
      state: parsed.data.state,
      failureCode: parsed.data.failureCode ?? null,
    });
  }
  return NextResponse.json({ ok: true }, { headers: cors });
}
