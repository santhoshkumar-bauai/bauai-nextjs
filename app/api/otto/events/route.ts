import { NextResponse } from "next/server";
import { z } from "zod";

import { getIngestionDb } from "@/lib/ingestion/db/client";
import { logger } from "@/lib/ingestion/observability/logger";
import { getCompanyContext } from "@/lib/company/context";
import { ONBOARDING_EVENTS } from "@/lib/onboarding/telemetry";
import { forCompanyContext } from "@/lib/ai/tenant/repository";

const log = logger.child("ai.otto.events");

const eventSchema = z.object({
  name: z.enum(ONBOARDING_EVENTS),
  milestoneId: z.string().max(64).optional(),
  tool: z.string().max(64).optional(),
  reason: z.string().max(500).optional(),
  selector: z.string().max(200).optional(),
  route: z.string().max(200).optional(),
});

/**
 * Onboarding event sink. Authenticated — this writes rows, so an open endpoint
 * would be a free way to fill the collection.
 *
 * Failures are logged at `warn` and everything else at `info`, so the drift
 * signal (an unknown milestone id, a selector that resolved to nothing) stands
 * out from ordinary progress in the same log stream.
 */
export async function POST(request: Request) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = eventSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid event" }, { status: 400 });
  }

  const event = parsed.data;
  const tenantId = forCompanyContext(context).value;

  if (event.name === "tool_call_failed") {
    log.warn("onboarding tool call failed", {
      userId: context.userId,
      tool: event.tool,
      reason: event.reason,
      milestoneId: event.milestoneId,
      selector: event.selector,
      route: event.route,
    });
  } else {
    log.info(event.name, {
      userId: context.userId,
      milestoneId: event.milestoneId,
    });
  }

  try {
    const db = await getIngestionDb();
    await db.collection("onboarding_events").insertOne({
      ...event,
      tenantId,
      userId: context.userId,
      createdAt: new Date(),
    });
  } catch (error) {
    // The log line above is the durable record that matters; a write failure
    // here must not turn into a client-visible error on a beacon.
    log.warn("failed to persist onboarding event", { error: String(error) });
  }

  return NextResponse.json({ ok: true });
}
