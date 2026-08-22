import type { GaebCategory, GaebItem } from "./types";

/**
 * Deterministic BOQ money math, shared by the API (authoritative totals, X84
 * writer, export verification) and the client (live totals while typing).
 * Isomorphic and dependency-free on purpose. The model never computes any of
 * this — it only proposes unit prices.
 */

/**
 * GAEB rounding: half away from zero to two decimals.
 *
 * Unit prices carry up to three decimals and quantities up to three, so a
 * line total has at most six true decimals. Scaling to integer micro-euros
 * with one `Math.round` absorbs binary float dust (1.005 → 1004999.99…, but
 * its micro representation 1005000 is exact), after which the half-cent
 * decision is exact integer arithmetic — no `3 × 19.99` style drift.
 */
export function roundGaeb(value: number): number {
  if (!Number.isFinite(value)) return Number.NaN;
  const sign = value < 0 ? -1 : 1;
  const micros = Math.round(Math.abs(value) * 1_000_000);
  const wholeCents = Math.floor(micros / 10_000);
  const remainder = micros % 10_000;
  const cents = remainder >= 5_000 ? wholeCents + 1 : wholeCents;
  return (sign * cents) / 100;
}

/** The item fields the money math needs — satisfied by both the full parsed
 * item and the compact client view, so server and client share this module. */
export type GaebTotalsItem = Pick<
  GaebItem,
  "key" | "qty" | "markers" | "notInTotal" | "categoryKey"
>;

/** Line total in cents, or null when it cannot be computed. */
function lineTotalCents(item: GaebTotalsItem, unitPrice: number | null | undefined): number | null {
  if (unitPrice === null || unitPrice === undefined || !Number.isFinite(unitPrice)) return null;
  const qty = item.qty ?? (item.markers.includes("lump_sum") ? 1 : null);
  if (qty === null || !Number.isFinite(qty)) return null;
  return Math.round(roundGaeb(unitPrice * qty) * 100);
}

export interface GaebTotals {
  /** Line total per item key (euros, 2 decimals), null when uncomputable. */
  byItem: Map<string, { total: number | null }>;
  /** Net per category key, rolled up through ancestors when the tree is given. */
  byCategory: Map<string, { net: number; itemCount: number; pricedCount: number }>;
  net: number;
  vat: number;
  gross: number;
  /** In-scope items (counted toward the total) without a usable price. */
  unpricedCount: number;
  /** Items excluded from rollups: Bedarf without GB, alternatives. */
  excludedKeys: string[];
}

export function computeTotals(input: {
  items: ReadonlyArray<GaebTotalsItem>;
  /** Working unit prices by item key; missing/null = unpriced. */
  prices: ReadonlyMap<string, number | null>;
  vatRate: number | null;
  /** Category tree for ancestor rollups; omit for flat aggregation only. */
  categories?: ReadonlyArray<Pick<GaebCategory, "key" | "parentKey">>;
}): GaebTotals {
  const byItem = new Map<string, { total: number | null }>();
  const byCategory = new Map<string, { net: number; itemCount: number; pricedCount: number }>();
  const parentOf = new Map<string, string | null>();
  for (const category of input.categories ?? []) {
    parentOf.set(category.key, category.parentKey);
    byCategory.set(category.key, { net: 0, itemCount: 0, pricedCount: 0 });
  }

  const excludedKeys: string[] = [];
  let netCents = 0;
  let unpricedCount = 0;

  const addToCategoryChain = (
    categoryKey: string,
    cents: number | null,
    priced: boolean,
  ): void => {
    let key: string | null = categoryKey;
    const seen = new Set<string>();
    while (key && !seen.has(key)) {
      seen.add(key);
      const bucket =
        byCategory.get(key) ?? { net: 0, itemCount: 0, pricedCount: 0 };
      bucket.itemCount += 1;
      if (priced) bucket.pricedCount += 1;
      if (cents !== null) bucket.net += cents;
      byCategory.set(key, bucket);
      key = parentOf.get(key) ?? null;
    }
  };

  for (const item of input.items) {
    const unitPrice = input.prices.get(item.key) ?? null;
    const cents = lineTotalCents(item, unitPrice);
    byItem.set(item.key, { total: cents === null ? null : cents / 100 });

    if (item.notInTotal) {
      excludedKeys.push(item.key);
      continue;
    }

    const priced = unitPrice !== null && unitPrice !== undefined && Number.isFinite(unitPrice);
    if (!priced) unpricedCount += 1;
    if (cents !== null) netCents += cents;
    addToCategoryChain(item.categoryKey, cents, priced);
  }

  for (const bucket of byCategory.values()) {
    bucket.net = bucket.net / 100;
  }

  const net = netCents / 100;
  const vat =
    input.vatRate === null || !Number.isFinite(input.vatRate)
      ? 0
      : roundGaeb((netCents / 100) * (input.vatRate / 100));
  return {
    byItem,
    byCategory,
    net,
    vat,
    gross: roundGaeb(net + vat),
    unpricedCount,
    excludedKeys,
  };
}
