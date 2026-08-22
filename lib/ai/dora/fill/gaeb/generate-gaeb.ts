import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";
import { connectMongoose } from "@/lib/db/mongoose";
import { getPriceSheet, priceMap } from "@/lib/gaeb/price-sheet";
import { getOrParseGaebDocument } from "@/lib/gaeb/store";
import type { GaebPartyBlock } from "@/lib/gaeb/types";
import { computeTotals } from "@/lib/gaeb/totals";
import { buildX84, verifyX84 } from "@/lib/gaeb/xml/build-x84";
import { createWorkspaceDocumentFromObject } from "@/lib/onlyoffice/document-service";
import { workspaceFormat } from "@/lib/onlyoffice/formats";
import { workspacePendingKey } from "@/lib/onlyoffice/storage";
import { getObjectBuffer, putObjectBuffer } from "@/lib/storage/s3";
import { WorkspaceDocument } from "@/models/workspace-document";
import { WorkspaceDocumentVersion } from "@/models/workspace-document-version";

import { updateFillRun } from "../runs";
import type { DocumentFillRunDocument } from "../types";

/**
 * X84 generation — the GAEB "building/storing" stages. Reads ONLY Layer C
 * (the price sheet): the run's suggestions never reach the file except
 * through an explicit user decision. Mirrors generateDocumentFillCopy:
 * verify before any S3 write, always a NEW workspace document.
 */
export async function generateGaebFillCopy(runIdHex: string): Promise<void> {
  const runId = new ObjectId(runIdHex);
  const { documentFillRuns } = await getAiCollections();
  const run = await documentFillRuns.findOne({ _id: runId });
  if (!run || !["review", "generating"].includes(run.status)) return;
  await updateFillRun(runId, { status: "generating", stage: "building", error: null });

  try {
    await connectMongoose();
    const [source, version] = await Promise.all([
      WorkspaceDocument.findOne({
        _id: run.documentId,
        companyId: run.tenantId,
        deletedAt: null,
      }).lean(),
      WorkspaceDocumentVersion.findOne({
        _id: run.sourceVersionId,
        documentId: run.documentId,
        sha256: run.sourceSha256,
        state: "committed",
      }).lean(),
    ]);
    if (!source || !version) throw new Error("source_version_missing");
    if (source.documentType !== "gaeb") throw new Error("gaeb_required");

    const stored = await getOrParseGaebDocument({
      tenantId: run.tenantId,
      documentId: run.documentId,
      versionId: new ObjectId(String(version._id)),
      sourceSha256: version.sha256,
      s3Key: version.s3Key,
      extension: version.extension,
    });
    if (!stored.document) {
      throw new Error(`gaeb_parse_failed:${stored.parseError?.code ?? "unknown"}`);
    }
    const parsed = stored.document;

    const sheet = await getPriceSheet(run.tenantId, run.documentId);
    if (sheet && sheet.sourceSha256 !== run.sourceSha256) {
      throw new Error("gaeb_price_sheet_stale");
    }
    const workingPrices = priceMap(sheet);

    // The export gate, enforced server-side regardless of what the UI showed:
    // every position that counts toward the total needs a decided price.
    const totals = computeTotals({
      items: parsed.items,
      prices: workingPrices,
      vatRate: parsed.meta.vatRate,
      categories: parsed.categories,
    });
    if (totals.unpricedCount > 0) {
      const unpricedOz = parsed.items
        .filter(
          (item) =>
            !item.notInTotal &&
            (workingPrices.get(item.key) === undefined || workingPrices.get(item.key) === null),
        )
        .slice(0, 20)
        .map((item) => item.oz);
      throw new Error(`gaeb_unpriced_items:${totals.unpricedCount}:${unpricedOz.join(",")}`);
    }

    const prices = new Map<string, number>();
    for (const [itemKey, value] of workingPrices) {
      if (value !== null && Number.isFinite(value)) prices.set(itemKey, value);
    }

    const bidder = resolveBidder(run, sheet?.bidder ?? null, parsed.meta.bidder);
    const sourceBytes = await getObjectBuffer(version.s3Key);
    const outputBytes = buildX84({ sourceBytes, source: parsed, prices, bidder });

    // Verified BEFORE anything is stored — a bad write never leaves an
    // orphaned S3 object, exactly like verifyFilledPdf.
    const verdict = verifyX84(outputBytes, { source: parsed, prices });
    if (!verdict.ok) {
      throw new Error(`gaeb_verification_failed:${verdict.failures.join(",")}`.slice(0, 300));
    }

    await updateFillRun(runId, { stage: "storing" });
    const stem = source.fileName.replace(/\.[xdp]8[1-6]$/i, "");
    const fileName = `${stem} - Angebot.x84`;
    const format = workspaceFormat(fileName);
    if (!format) throw new Error("generated_format_invalid");
    const pendingKey = workspacePendingKey(
      run.tenantId.toHexString(),
      run.documentId.toHexString(),
    );
    await putObjectBuffer(pendingKey, outputBytes, format.contentType);

    const generated = await createWorkspaceDocumentFromObject({
      companyId: source.companyId,
      tenderId: source.tenderId ?? null,
      source: {
        kind: "generated-fill",
        sourceDocumentId: source._id,
        fillRunId: run._id,
      },
      fileName,
      format,
      contentType: format.contentType,
      size: outputBytes.byteLength,
      sha256: createHash("sha256").update(outputBytes).digest("hex"),
      sourceKey: pendingKey,
      actorId: run.startedByUserId,
      versionReason: "generated_fill",
    });
    await updateFillRun(runId, {
      status: "completed",
      stage: "done",
      generatedDocumentId: new ObjectId(String(generated._id)),
      finishedAt: new Date(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "generation_failed";
    // Pricing gaps and stale sheets are user-fixable review states, not run
    // failures — send the run back to review so nothing is lost.
    if (message.startsWith("gaeb_unpriced_items") || message === "gaeb_price_sheet_stale") {
      await updateFillRun(runId, {
        status: "review",
        stage: "review",
        error: message.slice(0, 500),
      });
    } else {
      await updateFillRun(runId, {
        status: "failed",
        error: message.slice(0, 500),
        finishedAt: new Date(),
      });
    }
    throw error;
  }
}

/** Bidder block priority: user-reviewed run fields > price sheet > source. */
function resolveBidder(
  run: DocumentFillRunDocument,
  sheetBidder: GaebPartyBlock | null,
  sourceBidder: GaebPartyBlock | null,
): GaebPartyBlock | null {
  const base: GaebPartyBlock = {
    name: sheetBidder?.name ?? sourceBidder?.name ?? null,
    street: sheetBidder?.street ?? sourceBidder?.street ?? null,
    zip: sheetBidder?.zip ?? sourceBidder?.zip ?? null,
    city: sheetBidder?.city ?? sourceBidder?.city ?? null,
    contact: sheetBidder?.contact ?? sourceBidder?.contact ?? null,
    email: sheetBidder?.email ?? sourceBidder?.email ?? null,
  };
  for (const field of run.fields) {
    if (field.locator?.strategy !== "gaeb_meta" || !field.value) continue;
    if (field.state !== "ready" && field.state !== "needs_review") continue;
    const key = field.locator.key.split(".")[1] as keyof GaebPartyBlock;
    if (key in base) base[key] = field.value;
  }
  return Object.values(base).some((value) => value !== null) ? base : null;
}
