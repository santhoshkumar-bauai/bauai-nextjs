import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getFillSession, serializeFillSession } from "@/lib/ai/fill-agent/store";
import { applyUserFieldValues } from "@/lib/ai/fill-agent/values";
import { forCompanyContext } from "@/lib/ai/tenant/repository";
import { getCompanyContext } from "@/lib/company/context";

/**
 * The values-form submit: user-typed values land in the session directly
 * (same code path as the set_field_values chat tool, so the sensitivity
 * ratchet applies identically). The agent picks them up on its next turn via
 * get_session_status / fill_and_validate.
 */

const postSchema = z.object({
  values: z
    .array(
      z.object({
        fieldId: z.string().min(1).max(80),
        value: z.string().max(2000),
      }),
    )
    .min(1)
    .max(60),
});

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId } = await params;
  if (!ObjectId.isValid(sessionId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const parsed = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const tenantId = forCompanyContext(context).value;
  const session = await getFillSession(tenantId, new ObjectId(sessionId));
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await applyUserFieldValues({
    tenantId,
    session,
    values: parsed.data.values,
  });

  return NextResponse.json({
    session: serializeFillSession(result.session),
    applied: result.applied,
    unknown: result.unknown,
  });
}
