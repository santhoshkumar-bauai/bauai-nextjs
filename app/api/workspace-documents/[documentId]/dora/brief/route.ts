import { after } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { generateBrief, getBriefState, serializeBrief } from "@/lib/ai/dora/brief";
import { claimBriefRun, getBriefRun, serializeBriefRun } from "@/lib/ai/dora/brief-runs";
import { buildDoraRunContext } from "@/lib/ai/dora/context";
import type { WireBriefStatus } from "@/lib/ai/dora/wire";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { aiProviderConfigured } from "@/lib/ai/gateway/config";

/**
 * Dora's Document Brief for one workspace document. GET returns the current
 * run + stored brief (the panel's 1.5s poll target while running); POST
 * claims a run and generates detached via after() — the reader can navigate
 * away and find the work still in progress (report-run pattern).
 */

const postSchema = z.object({
  refresh: z.boolean().optional(),
});

export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId } = await params;
  const ctx = await buildDoraRunContext({
    companyContext: context,
    documentIdHex: documentId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [run, briefState] = await Promise.all([
    getBriefRun(ctx.tenantId, ctx.document.documentId),
    getBriefState(ctx),
  ]);

  const body: WireBriefStatus = {
    run: run ? serializeBriefRun(run) : null,
    brief: briefState
      ? serializeBrief(briefState.doc, briefState.stale, ctx.locale)
      : null,
    current: { storageRevision: ctx.document.storageRevision },
  };
  return NextResponse.json(body);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!aiProviderConfigured()) {
    return NextResponse.json({ error: "No AI provider configured." }, { status: 503 });
  }

  const { documentId } = await params;
  const parsed = postSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const ctx = await buildDoraRunContext({
    companyContext: context,
    documentIdHex: documentId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!ctx.document.version) {
    // Nothing committed yet (still uploading/converting) — nothing to analyze.
    return NextResponse.json({ error: "document_not_ready" }, { status: 409 });
  }

  const claimed = await claimBriefRun({
    tenantId: ctx.tenantId,
    documentId: ctx.document.documentId,
    userId: ctx.userId,
  });

  if (!claimed) {
    // Someone else's generation is in flight — watch theirs instead.
    const existing = await getBriefRun(ctx.tenantId, ctx.document.documentId);
    return NextResponse.json(
      { run: existing ? serializeBriefRun(existing) : null, joined: true },
      { status: 202 },
    );
  }

  // Survives the response: the panel polls GET for progress.
  after(() => generateBrief({ ctx, refresh: parsed.data.refresh ?? false }));

  return NextResponse.json(
    { run: serializeBriefRun(claimed), joined: false },
    { status: 202 },
  );
}
