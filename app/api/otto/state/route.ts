import { NextResponse } from "next/server";
import { z } from "zod";

import { setOttoStatus } from "@/lib/ai/otto/service";
import { getCompanyContext } from "@/lib/company/context";

/**
 * Otto's lifecycle switch. The important one is `dismissed`: the brief's
 * hard requirement is that a user can leave in one click and STAY gone, which
 * only holds if the decision is stored server-side rather than in a cookie or
 * local storage that a new device forgets.
 */

const patchSchema = z.object({
  // "completed" is deliberately absent — that is derived from real progress by
  // the graph, never asserted by the client.
  status: z.enum(["in_progress", "dismissed"]),
});

export async function PATCH(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  await setOttoStatus({ userId: context.userId, status: parsed.data.status });
  return NextResponse.json({ ok: true, status: parsed.data.status });
}
