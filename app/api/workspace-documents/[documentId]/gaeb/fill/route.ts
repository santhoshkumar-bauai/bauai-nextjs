import { NextResponse } from "next/server";
import { z } from "zod";

import { analyzeFillRun } from "@/lib/ai/dora/fill/analyze";
import {
  dispatchDocumentFillTask,
  fillGenerationDisposition,
  gaebFillRequiresQueueMode,
} from "@/lib/ai/dora/fill/execution";
import { fillFormatFor } from "@/lib/ai/dora/fill/format";
import { generateDocumentFillCopy } from "@/lib/ai/dora/fill/generate";
import {
  listGaebFillItems,
  resetFailedGaebFillItems,
  serializeGaebFillItem,
} from "@/lib/ai/dora/fill/gaeb/items";
import {
  createFillRun,
  latestFillRun,
  patchFillFields,
  serializeFillRun,
  updateFillRun,
} from "@/lib/ai/dora/fill/runs";
import { fillPatchSchema } from "@/lib/ai/dora/fill/schema";
import { aiEnv } from "@/lib/ai/config/env";
import { getAiCollections } from "@/lib/ai/db/collections";
import { getCompanyContext } from "@/lib/company/context";
import { loadGaebRouteScope, type GaebRouteScope } from "@/lib/gaeb/route-context";
import { getOrParseGaebDocument } from "@/lib/gaeb/store";
import {
  enqueueDocumentFillAnalysis,
  enqueueDocumentFillGeneration,
} from "@/lib/onlyoffice/queue";

/**
 * GAEB fill-run lifecycle for the BOQ editor (same-origin cookie auth — the
 * bearer dora-gateway serves only the cross-origin ONLYOFFICE iframe).
 * Guards mirror app/api/dora-gateway/fill/[documentId]/route.ts.
 */

const postSchema = z.object({
  action: z.enum(["analyze", "retry_failed", "generate"]),
  sourceStorageRevision: z.number().int().positive().optional(),
});

const ACTIVE_STATUSES = ["queued", "analyzing", "generating"];

async function loadScope(documentId: string): Promise<
  | { ok: true; scope: GaebRouteScope & { version: NonNullable<GaebRouteScope["version"]> } }
  | { ok: false; response: NextResponse }
> {
  const context = await getCompanyContext();
  if (!context) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  const scope = await loadGaebRouteScope(context, documentId);
  if (!scope || scope.documentType !== "gaeb") {
    return { ok: false, response: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  }
  if (!scope.version) {
    return {
      ok: false,
      response: NextResponse.json({ error: "no_committed_version" }, { status: 409 }),
    };
  }
  return { ok: true, scope: scope as GaebRouteScope & { version: NonNullable<GaebRouteScope["version"]> } };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const loaded = await loadScope(documentId);
  if (!loaded.ok) return loaded.response;
  const { scope } = loaded;

  const run = await latestFillRun(scope.tenantId, scope.documentId);
  if (!run) return NextResponse.json({ run: null, items: [], counts: null });

  const url = new URL(request.url);
  const since = url.searchParams.get("since");
  const sinceDate = since ? new Date(since) : null;
  const all = await listGaebFillItems(run._id);
  const items = (
    sinceDate && !Number.isNaN(sinceDate.getTime())
      ? all.filter((item) => item.updatedAt > sinceDate)
      : all
  ).map(serializeGaebFillItem);
  const counts = {
    pending: 0,
    classified: 0,
    priced: 0,
    failed: 0,
    skipped: 0,
  } as Record<string, number>;
  for (const item of all) counts[item.status] += 1;

  return NextResponse.json({ run: serializeFillRun(run), items, counts });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const loaded = await loadScope(documentId);
  if (!loaded.ok) return loaded.response;
  const { scope } = loaded;

  const fillFormat = fillFormatFor({
    documentType: scope.documentType,
    extension: scope.version.extension,
  });
  if (fillFormat !== "gaeb") {
    return NextResponse.json({ error: "fill_unsupported_document" }, { status: 409 });
  }

  const parsedBody = postSchema.safeParse(await request.json().catch(() => null));
  if (!parsedBody.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const { action } = parsedBody.data;

  if (action === "analyze") {
    if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: "no_ai_provider" }, { status: 503 });
    }
    const active = await latestFillRun(scope.tenantId, scope.documentId);
    if (active && ACTIVE_STATUSES.includes(active.status)) {
      return NextResponse.json({ error: "fill_run_in_progress" }, { status: 409 });
    }
    // The run is pinned to one revision — reject when the editor's view of
    // the document is no longer what is stored.
    if (
      parsedBody.data.sourceStorageRevision !== undefined &&
      parsedBody.data.sourceStorageRevision !== scope.version.storageRevision
    ) {
      return NextResponse.json({ error: "source_revision_changed" }, { status: 409 });
    }

    // Parse up front: rejects unparseable files with a clear code and gives
    // the queue gate its position count.
    const stored = await getOrParseGaebDocument({
      tenantId: scope.tenantId,
      documentId: scope.documentId,
      versionId: scope.version.id,
      sourceSha256: scope.version.sha256,
      s3Key: scope.version.s3Key,
      extension: scope.version.extension,
    });
    if (!stored.document) {
      return NextResponse.json(
        { error: "gaeb_parse_failed", code: stored.parseError?.code ?? "unknown" },
        { status: 409 },
      );
    }
    const itemCount = stored.document.items.length;
    if (itemCount > aiEnv().gaebFillMaxPositions) {
      return NextResponse.json({ error: "gaeb_too_many_positions" }, { status: 409 });
    }
    if (gaebFillRequiresQueueMode({ itemCount })) {
      return NextResponse.json({ error: "gaeb_requires_queue_mode" }, { status: 409 });
    }

    const run = await createFillRun({
      tenantId: scope.tenantId,
      documentId: scope.documentId,
      format: "gaeb",
      sourceVersionId: scope.version.id,
      sourceStorageRevision: scope.version.storageRevision,
      sourceSha256: scope.version.sha256,
      snapshotId: null,
      snapshotHash: null,
      userId: scope.userId,
    });
    const mode = await dispatchDocumentFillTask({
      inline: () => analyzeFillRun(run._id.toHexString()),
      queued: () => enqueueDocumentFillAnalysis(run._id.toHexString()),
    });
    const latest = mode === "queue" ? run : await latestFillRun(scope.tenantId, scope.documentId);
    return NextResponse.json(
      { run: serializeFillRun(latest ?? run) },
      { status: mode === "queue" ? 202 : 200 },
    );
  }

  if (action === "retry_failed") {
    const run = await latestFillRun(scope.tenantId, scope.documentId);
    if (!run || !["review", "failed"].includes(run.status)) {
      return NextResponse.json({ error: "fill_review_required" }, { status: 409 });
    }
    const reset = await resetFailedGaebFillItems(run._id);
    if (reset === 0 && run.status === "review") {
      return NextResponse.json({ run: serializeFillRun(run) });
    }
    await updateFillRun(run._id, { status: "analyzing", stage: "validating", error: null });
    await dispatchDocumentFillTask({
      inline: () => analyzeFillRun(run._id.toHexString()),
      queued: () => enqueueDocumentFillAnalysis(run._id.toHexString()),
    });
    const latest = await latestFillRun(scope.tenantId, scope.documentId);
    return NextResponse.json({ run: serializeFillRun(latest ?? run) });
  }

  // action === "generate"
  let run = await latestFillRun(scope.tenantId, scope.documentId);
  if (run && ACTIVE_STATUSES.includes(run.status)) {
    return NextResponse.json({ error: "fill_run_in_progress" }, { status: 409 });
  }
  const disposition = fillGenerationDisposition(run);
  if (disposition === "completed" && run) {
    return NextResponse.json({ run: serializeFillRun(run) });
  }
  if (!run || disposition === "review_required") {
    // Manual pricing without an AI run still exports through a run, so every
    // X84 gets the stage ladder and audit trail.
    run = await createFillRun({
      tenantId: scope.tenantId,
      documentId: scope.documentId,
      format: "gaeb",
      sourceVersionId: scope.version.id,
      sourceStorageRevision: scope.version.storageRevision,
      sourceSha256: scope.version.sha256,
      snapshotId: null,
      snapshotHash: null,
      userId: scope.userId,
    });
    await updateFillRun(run._id, { status: "review", stage: "review" });
  }
  if (run.sourceSha256 !== scope.version.sha256) {
    return NextResponse.json({ error: "source_revision_changed" }, { status: 409 });
  }

  try {
    const mode = await dispatchDocumentFillTask({
      inline: () => generateDocumentFillCopy(run._id.toHexString()),
      queued: async () => {
        await enqueueDocumentFillGeneration(run._id.toHexString());
        await updateFillRun(run._id, { status: "generating", stage: "building", error: null });
      },
    });
    const latest = await latestFillRun(scope.tenantId, scope.documentId);
    return NextResponse.json(
      { run: serializeFillRun(latest ?? run) },
      { status: mode === "queue" ? 202 : 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "generation_failed";
    if (message.startsWith("gaeb_unpriced_items")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    throw error;
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const loaded = await loadScope(documentId);
  if (!loaded.ok) return loaded.response;
  const { scope } = loaded;

  const parsed = fillPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const run = await patchFillFields({
    tenantId: scope.tenantId,
    documentId: scope.documentId,
    updates: parsed.data.fields,
  });
  if (!run) return NextResponse.json({ error: "fill_review_required" }, { status: 409 });
  return NextResponse.json({ run: serializeFillRun(run) });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const { documentId } = await params;
  const loaded = await loadScope(documentId);
  if (!loaded.ok) return loaded.response;
  const { scope } = loaded;

  const run = await latestFillRun(scope.tenantId, scope.documentId);
  if (run && !["completed", "cancelled"].includes(run.status)) {
    // The batch loop observes the status flip and stops at the next batch.
    const { documentFillRuns } = await getAiCollections();
    await documentFillRuns.updateOne(
      { _id: run._id },
      { $set: { status: "cancelled", finishedAt: new Date(), updatedAt: new Date() } },
    );
  }
  return NextResponse.json({ ok: true });
}
