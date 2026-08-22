import { NextResponse } from "next/server";

import { getAiCollections } from "@/lib/ai/db/collections";
import { serializeGaebFillItem } from "@/lib/ai/dora/fill/gaeb/items";
import { latestFillRun } from "@/lib/ai/dora/fill/runs";
import { getCompanyContext } from "@/lib/company/context";
import { loadGaebRouteScope } from "@/lib/gaeb/route-context";
import { getOrParseGaebDocument } from "@/lib/gaeb/store";

/** Full detail for one position: complete Langtext plus its fill item. */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ documentId: string; itemKey: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId, itemKey } = await params;
  const scope = await loadGaebRouteScope(context, documentId);
  if (!scope || scope.documentType !== "gaeb" || !scope.version) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const stored = await getOrParseGaebDocument({
    tenantId: scope.tenantId,
    documentId: scope.documentId,
    versionId: scope.version.id,
    sourceSha256: scope.version.sha256,
    s3Key: scope.version.s3Key,
    extension: scope.version.extension,
  });
  const item = stored.document?.items.find((entry) => entry.key === itemKey);
  if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const run = await latestFillRun(scope.tenantId, scope.documentId);
  let fillItem = null;
  if (run) {
    const { gaebFillItems } = await getAiCollections();
    const row = await gaebFillItems.findOne({ runId: run._id, itemKey });
    if (row) fillItem = serializeGaebFillItem(row);
  }

  const category = stored.document?.categories.find(
    (entry) => entry.key === item.categoryKey,
  );

  return NextResponse.json({
    item: {
      key: item.key,
      oz: item.oz,
      shortText: item.shortText,
      longText: item.longText,
      longTextTruncated: item.longTextTruncated,
      qty: item.qty,
      qtyUnit: item.qtyUnit,
      existingUnitPrice: item.existingUnitPrice,
      existingTotal: item.existingTotal,
      markers: item.markers,
      alternative: item.alternative,
      notInTotal: item.notInTotal,
      categoryPath: categoryPath(stored.document?.categories ?? [], category?.key ?? null),
    },
    fillItem,
  });
}

function categoryPath(
  categories: Array<{ key: string; parentKey: string | null; label: string; oz: string }>,
  leafKey: string | null,
): Array<{ oz: string; label: string }> {
  const byKey = new Map(categories.map((category) => [category.key, category]));
  const path: Array<{ oz: string; label: string }> = [];
  let key = leafKey;
  const seen = new Set<string>();
  while (key && !seen.has(key)) {
    seen.add(key);
    const category = byKey.get(key);
    if (!category) break;
    path.unshift({ oz: category.oz, label: category.label });
    key = category.parentKey;
  }
  return path;
}
