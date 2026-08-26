import { NextResponse } from "next/server";

import { buildFillAgentRunContext } from "@/lib/ai/fill-agent/context";
import {
  SandboxUnavailableError,
} from "@/lib/ai/fill-agent/sandbox-client";
import { getCompanyContext } from "@/lib/company/context";
import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { sanitizeFileName } from "@/lib/storage/s3";

/**
 * Export the CURRENT state of the fill — at any time, even partially filled.
 * Deterministic and LLM-free: the stored fieldmap replays through the
 * sandbox's prepare→fill lane (the two-phase product insight from the Python
 * POC — once mapped, a fill is a replay) and the bytes stream straight back.
 * No score gate: an export is the user's call, not the validator's.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { sessionId } = await params;
  const ctx = await buildFillAgentRunContext({
    companyContext: context,
    sessionIdHex: sessionId,
    locale: resolveRequestLocale(request),
  });
  if (!ctx) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (ctx.session.fieldmap.length === 0) {
    return NextResponse.json({ error: "no_fieldmap" }, { status: 409 });
  }

  try {
    const workspaceId = await ctx.ensureSandbox();
    await ctx.sandbox.uploadFile(
      workspaceId,
      "fieldmap.json",
      Buffer.from(JSON.stringify({ fields: ctx.session.fieldmap })),
    );
    await ctx.sandbox.runPrepare(workspaceId);
    await ctx.sandbox.runFill(workspaceId);
    const bytes = await ctx.sandbox.downloadFile(workspaceId, "filled.pdf");

    const fileName = sanitizeFileName(`filled-${ctx.session.source.fileName}`);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof SandboxUnavailableError) {
      return NextResponse.json({ error: "sandbox_unavailable" }, { status: 503 });
    }
    throw error;
  }
}
