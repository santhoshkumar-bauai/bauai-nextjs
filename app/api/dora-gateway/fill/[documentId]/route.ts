import { ObjectId } from "mongodb";
import { NextResponse } from "next/server";
import { z } from "zod";

import { buildDoraRunContext } from "@/lib/ai/dora/context";
import { analyzeFillRun } from "@/lib/ai/dora/fill/analyze";
import {
  dispatchDocumentFillTask,
  fillGenerationDisposition,
  fillRequiresQueueMode,
} from "@/lib/ai/dora/fill/execution";
import { fillFormatFor } from "@/lib/ai/dora/fill/format";
import { generateDocumentFillCopy } from "@/lib/ai/dora/fill/generate";
import {
  createFillRun,
  latestFillRun,
  patchFillFields,
  serializeFillRun,
  updateFillRun,
} from "@/lib/ai/dora/fill/runs";
import { fillPatchSchema } from "@/lib/ai/dora/fill/schema";
import {
  DoraGatewayAuthError,
  requireDoraGatewayAuth,
} from "@/lib/dora-gateway/context";
import { corsHeadersFor, handlePreflight } from "@/lib/dora-gateway/cors";
import { getDoraSnapshot } from "@/lib/dora-gateway/snapshots";
import {
  enqueueDocumentFillAnalysis,
  enqueueDocumentFillGeneration,
} from "@/lib/onlyoffice/queue";

type RouteParams = { params: Promise<{ documentId: string }> };
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("analyze"),
    // Word pins a live editor snapshot. PDF analysis reads the committed S3
    // bytes, so it sends none; the per-format requirement is enforced below.
    snapshotId: z.string().uuid().optional(),
    sourceStorageRevision: z.number().int().positive(),
  }),
  z.object({ action: z.literal("generate") }),
]);

export function OPTIONS(request: Request) {
  return handlePreflight(request);
}

async function context(request: Request, documentId: string) {
  const auth = await requireDoraGatewayAuth(request, documentId);
  const ctx = await buildDoraRunContext({
    companyContext: auth.companyContext,
    documentIdHex: documentId,
    locale: "en",
  });
  return { auth, ctx };
}

function authError(error: unknown, headers: Record<string, string>) {
  const status = error instanceof DoraGatewayAuthError ? error.status : 401;
  const message = error instanceof DoraGatewayAuthError ? error.message : "unauthorized";
  return NextResponse.json({ error: message }, { status, headers });
}

export async function GET(request: Request, { params }: RouteParams) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  const { documentId } = await params;
  try {
    const { ctx } = await context(request, documentId);
    if (!ctx) return NextResponse.json({ error: "not_found" }, { status: 404, headers: cors });
    const run = await latestFillRun(ctx.tenantId, ctx.document.documentId);
    return NextResponse.json({ run: run ? serializeFillRun(run) : null }, { headers: cors });
  } catch (error) {
    return authError(error, cors);
  }
}

export async function POST(request: Request, { params }: RouteParams) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  const { documentId } = await params;
  try {
    const { ctx } = await context(request, documentId);
    if (!ctx) return NextResponse.json({ error: "not_found" }, { status: 404, headers: cors });
    const fillFormat = fillFormatFor(ctx.document);
    if (!fillFormat) {
      // Keep the legacy string for Word-ish documents so the existing panel
      // copy still resolves; anything else gets the generic refusal.
      return NextResponse.json(
        {
          error:
            ctx.document.documentType === "word"
              ? "word_docx_required"
              : "fill_unsupported_document",
        },
        { status: 409, headers: cors },
      );
    }
    if (fillFormat === "pdf" && process.env.DORA_PDF_FILL_ENABLED === "false") {
      return NextResponse.json({ error: "pdf_fill_disabled" }, { status: 409, headers: cors });
    }
    const parsed = actionSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: cors });
    }
    if (parsed.data.action === "analyze") {
      if (fillFormat === "docx" && !parsed.data.snapshotId) {
        return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: cors });
      }
      const active = await latestFillRun(ctx.tenantId, ctx.document.documentId);
      if (active && ["queued", "analyzing", "generating"].includes(active.status)) {
        return NextResponse.json({ error: "fill_run_in_progress" }, { status: 409, headers: cors });
      }
      const version = ctx.document.version;
      if (!version) return NextResponse.json({ error: "no_committed_version" }, { status: 409, headers: cors });
      // Applies to both formats: the run is pinned to one revision, and this is
      // the "the document changed since the panel loaded" guard.
      if (version.storageRevision !== parsed.data.sourceStorageRevision) {
        return NextResponse.json({ error: "source_revision_changed" }, { status: 409, headers: cors });
      }

      // Word only: the snapshot must still describe the live editor session.
      let snapshotId: string | null = null;
      let snapshotHash: string | null = null;
      if (fillFormat === "docx") {
        const snapshot = await getDoraSnapshot({
          snapshotId: parsed.data.snapshotId!,
          tenantId: ctx.tenantId.toHexString(),
          documentId,
          userId: ctx.userId,
        });
        if (!snapshot || snapshot.editorKey !== ctx.document.activeEditorKey) {
          return NextResponse.json({ error: "snapshot_stale" }, { status: 409, headers: cors });
        }
        snapshotId = snapshot._id;
        snapshotHash = snapshot.snapshotHash;
      } else if (
        fillRequiresQueueMode({ format: fillFormat, sizeBytes: version.size ?? 0 })
      ) {
        return NextResponse.json(
          { error: "pdf_requires_queue_mode" },
          { status: 409, headers: cors },
        );
      }

      const run = await createFillRun({
        tenantId: ctx.tenantId,
        documentId: ctx.document.documentId,
        format: fillFormat,
        sourceVersionId: version.id,
        sourceStorageRevision: version.storageRevision,
        sourceSha256: version.sha256,
        snapshotId,
        snapshotHash,
        userId: ctx.userId,
      });
      const mode = await dispatchDocumentFillTask({
        inline: () => analyzeFillRun(run._id.toHexString()),
        queued: () => enqueueDocumentFillAnalysis(run._id.toHexString()),
      });
      if (mode === "queue") {
        return NextResponse.json({ run: serializeFillRun(run) }, { status: 202, headers: cors });
      }
      const analyzed = await latestFillRun(ctx.tenantId, ctx.document.documentId);
      if (!analyzed) throw new Error("fill_run_missing_after_analysis");
      return NextResponse.json({ run: serializeFillRun(analyzed) }, { headers: cors });
    }
    const run = await latestFillRun(ctx.tenantId, ctx.document.documentId);
    const disposition = fillGenerationDisposition(run);
    if (disposition === "completed" && run) {
      return NextResponse.json({ run: serializeFillRun(run) }, { headers: cors });
    }
    if (!run || disposition === "review_required") {
      return NextResponse.json({ error: "fill_review_required" }, { status: 409, headers: cors });
    }
    const ready = run.fields.filter((field) => field.state === "ready" && !field.sensitive);
    if (ready.length === 0) {
      return NextResponse.json({ error: "no_ready_fields" }, { status: 409, headers: cors });
    }
    const mode = await dispatchDocumentFillTask({
      inline: () => generateDocumentFillCopy(run._id.toHexString()),
      queued: async () => {
        await enqueueDocumentFillGeneration(run._id.toHexString());
        await updateFillRun(run._id, { status: "generating", stage: "building", error: null });
      },
    });
    if (mode === "queue") {
      const queued = { ...run, status: "generating" as const, stage: "building" as const };
      return NextResponse.json({ run: serializeFillRun(queued) }, { status: 202, headers: cors });
    }
    const generated = await latestFillRun(ctx.tenantId, ctx.document.documentId);
    if (!generated) throw new Error("fill_run_missing_after_generation");
    return NextResponse.json({ run: serializeFillRun(generated) }, { headers: cors });
  } catch (error) {
    if (error instanceof DoraGatewayAuthError) return authError(error, cors);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "failed" },
      { status: 500, headers: cors },
    );
  }
}

export async function PATCH(request: Request, { params }: RouteParams) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  const { documentId } = await params;
  try {
    const { ctx } = await context(request, documentId);
    if (!ctx) return NextResponse.json({ error: "not_found" }, { status: 404, headers: cors });
    const parsed = fillPatchSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400, headers: cors });
    const run = await patchFillFields({
      tenantId: ctx.tenantId,
      documentId: ctx.document.documentId,
      updates: parsed.data.fields,
    });
    if (!run) return NextResponse.json({ error: "fill_review_required" }, { status: 409, headers: cors });
    return NextResponse.json({ run: serializeFillRun(run) }, { headers: cors });
  } catch (error) {
    return authError(error, cors);
  }
}

export async function DELETE(request: Request, { params }: RouteParams) {
  const cors = corsHeadersFor(request);
  if (!cors) return NextResponse.json({ error: "origin_not_allowed" }, { status: 403 });
  const { documentId } = await params;
  try {
    const { ctx } = await context(request, documentId);
    if (!ctx) return NextResponse.json({ error: "not_found" }, { status: 404, headers: cors });
    const run = await latestFillRun(ctx.tenantId, new ObjectId(documentId));
    if (run && !["completed", "cancelled"].includes(run.status)) {
      await updateFillRun(run._id, { status: "cancelled", finishedAt: new Date() });
    }
    return NextResponse.json({ ok: true }, { headers: cors });
  } catch (error) {
    return authError(error, cors);
  }
}
