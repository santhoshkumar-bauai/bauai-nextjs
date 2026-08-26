import { after, NextResponse } from "next/server";

import { buildFillAgentRunContext } from "@/lib/ai/fill-agent/context";
import { updateFillSession } from "@/lib/ai/fill-agent/store";
import { runFillWorkflow } from "@/lib/ai/fill-agent/workflow-graph";
import { fillWorkflowRequestSchema } from "@/lib/ai/fill-agent/workflow-request";
import { emptyFillWorkflow } from "@/lib/ai/fill-agent/workflow-wire";
import { applyWorkflowInput } from "@/lib/ai/fill-agent/values";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const companyContext = await getCompanyContext();
  if (!companyContext) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { sessionId } = await params;
  const parsed = fillWorkflowRequestSchema.safeParse(await request.json().catch(() => null));
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
  } else if (parsed.data.action === "retry") {
    const workflow = { ...emptyFillWorkflow(), ...(ctx.session.workflow ?? {}) };
    const updated = await updateFillSession(ctx.tenantId, ctx.session._id!, {
      status: "ready",
      score: null,
      issues: [],
      workflow: {
        ...workflow,
        runId: (ctx.session.workflow?.runId ?? 0) + 1,
        status: "queued",
        currentBatchId: null,
        batches: [],
        activeCrop: null,
      },
    });
    if (updated) ctx.session = updated;
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
  return NextResponse.json({
    accepted: true,
    status: parsed.data.action === "resume" ? "resuming" : "queued",
  }, { status: 202 });
}
