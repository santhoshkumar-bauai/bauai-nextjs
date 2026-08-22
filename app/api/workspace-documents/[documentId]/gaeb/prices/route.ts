import { NextResponse } from "next/server";
import { z } from "zod";

import { getCompanyContext } from "@/lib/company/context";
import {
  patchPriceSheet,
  priceMap,
  resetPriceSheet,
} from "@/lib/gaeb/price-sheet";
import { loadGaebRouteScope } from "@/lib/gaeb/route-context";
import { serializePriceSheet, serializeTotals } from "@/lib/gaeb/serialize";
import { getOrParseGaebDocument } from "@/lib/gaeb/store";
import { computeTotals } from "@/lib/gaeb/totals";

/**
 * Working-price updates (Layer C). Every write is pinned to the source bytes
 * the client saw; a drifted document version 409s instead of silently pricing
 * the wrong file. Returns authoritative totals so the client can reconcile
 * its optimistic math.
 */

const partySchema = z.object({
  name: z.string().max(200).nullable(),
  street: z.string().max(200).nullable(),
  zip: z.string().max(20).nullable(),
  city: z.string().max(120).nullable(),
  contact: z.string().max(200).nullable(),
  email: z.string().max(200).nullable(),
});

const patchSchema = z.object({
  sourceSha256: z.string().min(16).max(128),
  reset: z.boolean().optional(),
  updates: z
    .array(
      z.object({
        itemKey: z.string().regex(/^i-\d{4,8}$/),
        unitPrice: z.number().finite().min(-10_000_000).max(10_000_000).nullable().optional(),
        decision: z.enum(["accepted", "edited", "rejected", "manual"]).nullable().optional(),
        suggestionRunId: z.string().max(64).nullable().optional(),
        note: z.string().max(2_000).nullable().optional(),
      }),
    )
    .max(600)
    .default([]),
  bidder: partySchema.nullable().optional(),
});

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ documentId: string }> },
) {
  const context = await getCompanyContext();
  if (!context) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { documentId } = await params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request" },
      { status: 400 },
    );
  }

  const scope = await loadGaebRouteScope(context, documentId);
  if (!scope || scope.documentType !== "gaeb") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!scope.version) {
    return NextResponse.json({ error: "no_committed_version" }, { status: 409 });
  }
  // The client must be pricing the bytes that are actually current.
  if (parsed.data.sourceSha256 !== scope.version.sha256) {
    return NextResponse.json({ error: "gaeb_source_changed" }, { status: 409 });
  }

  const sheet = parsed.data.reset
    ? await resetPriceSheet({
        tenantId: scope.tenantId,
        documentId: scope.documentId,
        sourceSha256: scope.version.sha256,
        userId: scope.userId,
      })
    : null;

  const result =
    parsed.data.updates.length > 0 || parsed.data.bidder !== undefined
      ? await patchPriceSheet({
          tenantId: scope.tenantId,
          documentId: scope.documentId,
          sourceSha256: scope.version.sha256,
          userId: scope.userId,
          updates: parsed.data.updates,
          bidder: parsed.data.bidder,
        })
      : sheet
        ? ({ ok: true, sheet } as const)
        : await patchPriceSheet({
            tenantId: scope.tenantId,
            documentId: scope.documentId,
            sourceSha256: scope.version.sha256,
            userId: scope.userId,
            updates: [],
          });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 });
  }

  const stored = await getOrParseGaebDocument({
    tenantId: scope.tenantId,
    documentId: scope.documentId,
    versionId: scope.version.id,
    sourceSha256: scope.version.sha256,
    s3Key: scope.version.s3Key,
    extension: scope.version.extension,
  });
  const totals = stored.document
    ? computeTotals({
        items: stored.document.items,
        prices: priceMap(result.sheet),
        vatRate: stored.document.meta.vatRate,
        categories: stored.document.categories,
      })
    : null;

  return NextResponse.json({
    priceSheet: serializePriceSheet(result.sheet),
    totals: totals ? serializeTotals(totals) : null,
  });
}
