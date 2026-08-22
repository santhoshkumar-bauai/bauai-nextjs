import type { GaebFillClassification } from "./items";

/**
 * Historical price retrieval seam. V1 has no pricing corpus, so this returns
 * nothing — but the interface, the prompt section, and the evidence plumbing
 * already exist, so Phase 2 (historical tenders, supplier catalogs, labor
 * rates) is a provider implementation, not a redesign.
 */

export interface ComparablePrice {
  /** Evidence reference key, e.g. "hist:tender_4812:item_183". */
  reference: string;
  description: string;
  unitPrice: number;
  unit: string;
  currency: string;
  similarity: number;
}

export async function retrieveComparables(input: {
  classification: GaebFillClassification | null;
  qtyUnit: string | null;
  region: string | null;
}): Promise<ComparablePrice[]> {
  void input;
  return [];
}
