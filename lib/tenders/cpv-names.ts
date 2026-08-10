/**
 * CPV code → readable category name.
 *
 * The two sides of this lookup disagree on format: the `cpvcodes` catalog is
 * seeded straight from the CPV 2008 annex and keeps the check digit
 * ("45000000-7"), while ingestion normalises tender codes to a bare 8-digit
 * stem ("45000000"). A plain `$in` between the two therefore matches nothing,
 * which is why tender cards used to fall back to printing raw code numbers.
 *
 * Matching on the stem — the same convention `lib/ai/agent/workspace.ts` uses
 * for the agent's catalog tool — makes both stored forms resolve.
 */
import { stripCheckDigit } from "@/lib/tenders/relevance";
import { CpvCode } from "@/models/cpv-code";

/**
 * Catalog filter matching each code on its 8-digit stem. Anchored so the
 * unique index on `code` still drives the scan.
 */
export function cpvStemFilter(codes: string[]): Record<string, unknown> | null {
  const stems = [...new Set(codes.map(stripCheckDigit).filter(Boolean))];
  if (stems.length === 0) return null;
  return { $or: stems.map((stem) => ({ code: { $regex: `^${stem}` } })) };
}

/**
 * Resolve codes to catalog names, keyed by bare stem so callers can look up
 * with whatever form the tender happens to carry.
 */
export async function resolveCpvNames(
  codes: string[],
  locale: "en" | "de",
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const filter = cpvStemFilter(codes);
  if (!filter) return names;

  const catalog = await CpvCode.find(filter).select({ code: 1, name: 1 }).lean();
  for (const entry of catalog) {
    const name = locale === "de" ? entry.name?.de : entry.name?.en;
    if (name) names.set(stripCheckDigit(entry.code), name);
  }
  return names;
}
