import { after, NextResponse } from "next/server";
import { z } from "zod";

import { buildFillAgentRunContext } from "@/lib/ai/fill-agent/context";
import { updateFillSession } from "@/lib/ai/fill-agent/store";
import { runFillWorkflow } from "@/lib/ai/fill-agent/workflow-graph";
import { emptyFillWorkflow } from "@/lib/ai/fill-agent/workflow-wire";
import { applyWorkflowInput } from "@/lib/ai/fill-agent/values";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({
    action: z.literal("resume"),
    values: z.array(z.object({ fieldId: z.string().min(1).max(80), value: z.string().max(2000) })).max(60).default([]),
    decisions: z.array(z.object({ groupId: z.string().min(1).max(200), fieldId: z.string().min(1).max(80) })).max(60).default([]),
  }),
]);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const companyContext = await getCompanyContext();
  if (!companyContext) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { sessionId } = await params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid workflow request" }, { status: 400 });
  const ctx = await buildFillAgentRunContext({
    companyContext,
    sessionIdHex: sessionId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.action === "resume") {
    ctx.session = await applyWorkflowInput({
      tenantId: ctx.tenantId,
      session: ctx.session,
      userId: ctx.userId,
      values: parsed.data.values,
      decisions: parsed.data.decisions,
    });
  }
  // The graph and its Mongo checkpoint thread are independent from the chat
  // request. `after` lets the route return immediately; interrupts persist
  // before this background continuation exits.
  after(async () => {
    try {
      await runFillWorkflow(ctx, parsed.data.action === "resume" ? { confirmed: true } : undefined);
    } catch (error) {
      const fresh = await ctx.reloadSession();
      const workflow = fresh.workflow ?? emptyFillWorkflow();
      const previous = workflow.activity.at(-1);
      const detail = error instanceof Error ? error.message.slice(0, 240) : "Unexpected workflow error";
      const cursor = workflow.activityCursor + 1;
      await updateFillSession(ctx.tenantId, fresh._id!, {
        status: "failed",
        workflow: {
          ...workflow,
          status: "needs_review",
          activityCursor: cursor,
          activity: [...workflow.activity, {
            cursor,
            at: new Date().toISOString(),
            action: previous?.action ?? "inspect_document",
            status: "failed" as const,
            batchId: previous?.batchId ?? null,
            pageStart: previous?.pageStart ?? null,
            pageEnd: previous?.pageEnd ?? null,
            message: `Workflow stopped: ${detail}`,
          }].slice(-500),
        },
      });
    }
  });
  return NextResponse.json({ accepted: true, status: parsed.data.action === "start" ? "queued" : "resuming" }, { status: 202 });
}
