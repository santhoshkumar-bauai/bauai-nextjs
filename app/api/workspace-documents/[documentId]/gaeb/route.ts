import { NextResponse } from "next/server";

import { serializeFillRun } from "@/lib/ai/dora/fill/runs";
import { latestFillRun } from "@/lib/ai/dora/fill/runs";
import { getCompanyContext } from "@/lib/company/context";
import { getPriceSheet, priceMap } from "@/lib/gaeb/price-sheet";
import { loadGaebRouteScope } from "@/lib/gaeb/route-context";
import { serializeGaebDocument, serializePriceSheet, serializeTotals } from "@/lib/gaeb/serialize";
import { getOrParseGaebDocument } from "@/lib/gaeb/store";
import { computeTotals } from "@/lib/gaeb/totals";

/**
 * The GAEB workspace view: parsed source (Layer A, parse-on-demand with
 * cache), the user's price sheet (Layer C), the latest fill run summary
 * (Layer B), and authoritative totals.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId } = await params;
  const scope = await loadGaebRouteScope(context, documentId);
  if (!scope) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (scope.documentType !== "gaeb") {
    return NextResponse.json({ error: "not_gaeb" }, { status: 409 });
  }
  if (!scope.version) {
    return NextResponse.json({ error: "no_committed_version", state: scope.state }, { status: 409 });
  }

  const stored = await getOrParseGaebDocument({
    tenantId: scope.tenantId,
    documentId: scope.documentId,
    versionId: scope.version.id,
    sourceSha256: scope.version.sha256,
    s3Key: scope.version.s3Key,
    extension: scope.version.extension,
  });

  const sheet = await getPriceSheet(scope.tenantId, scope.documentId);
  const run = await latestFillRun(scope.tenantId, scope.documentId);
  const sheetStale = Boolean(sheet && sheet.sourceSha256 !== scope.version.sha256);

  const totals = stored.document
    ? computeTotals({
        items: stored.document.items,
        prices: sheetStale ? new Map() : priceMap(sheet),
        vatRate: stored.document.meta.vatRate,
        categories: stored.document.categories,
      })
    : null;

  return NextResponse.json({
    source: {
      fileName: scope.fileName,
      extension: scope.version.extension,
      sha256: scope.version.sha256,
      storageRevision: scope.version.storageRevision,
      size: scope.version.size,
    },
    gaeb: serializeGaebDocument(stored),
    priceSheet: serializePriceSheet(sheet),
    priceSheetStale: sheetStale,
    totals: totals ? serializeTotals(totals) : null,
    fillRun: run ? serializeFillRun(run) : null,
  });
}
