import { getIngestionDb } from "../../ingestion/db/client.ts";
import { stripCheckDigit } from "../../tenders/relevance.ts";

/**
 * CPV codes → catalog names, via the native driver.
 *
 * Not `lib/tenders/cpv-names.ts`, which is Mongoose and therefore unusable
 * from the BullMQ worker. Names are joined bilingually because the corpus is
 * 49% German and 33% unlabelled — the German name is what matches the notice
 * text, the English one is what carries meaning for everything else.
 *
 * Resolving codes to names is the highest-leverage step in the whole matching
 * pipeline: "45210000" embeds as noise, "Hochbauarbeiten" embeds as meaning.
 *
 * The two sides disagree on format — the catalog is seeded from the CPV 2008
 * annex and keeps the check digit ("45000000-7"), while ingestion normalises
 * tender codes to a bare stem ("45000000"). A plain `$in` between them matches
 * nothing, silently, which is exactly what this function used to do: every
 * company profile lost its "Procurement categories" line and every judged
 * tender arrived with `categories: []`. Match on the stem, like
 * `lib/tenders/cpv-names.ts` and `lib/ai/agent/workspace.ts` already do.
 */
export function cpvStemFilter(codes: string[]): Record<string, unknown> | null {
  const stems = [...new Set(codes.map(stripCheckDigit).filter(Boolean))];
  if (stems.length === 0) return null;
  // Anchored so the unique index on `code` still drives the scan.
  return { $or: stems.map((stem) => ({ code: { $regex: `^${stem}` } })) };
}

export async function resolveCpvNameMap(
  codes: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const filter = cpvStemFilter(codes);
  if (!filter) return names;

  const db = await getIngestionDb();
  const rows = await db
    .collection<{ code: string; name?: { en?: string; de?: string } }>("cpvcodes")
    .find(filter)
    .project<{ code: string; name?: { en?: string; de?: string } }>({ code: 1, name: 1 })
    .toArray();

  for (const row of rows) {
    const pair = [row.name?.de, row.name?.en].filter(Boolean).join(" / ");
    if (pair) names.set(stripCheckDigit(row.code), pair);
  }
  return names;
}

/** Names for a code list, dropping any the catalog does not know. */
export async function resolveCpvNames(codes: string[]): Promise<string[]> {
  const map = await resolveCpvNameMap(codes);
  return [...new Set(codes.map((code) => map.get(stripCheckDigit(code))))].filter(
    (name): name is string => Boolean(name),
  );
}

/**
 * The two names kept apart rather than joined into one "de / en" string.
 *
 * Lexical matching needs them separate: the German name is the one that has
 * any chance of hitting a German notice body, and feeding "Bauarbeiten /
 * Construction work" to an analyzer as a single phrase matches neither.
 */
export async function resolveCpvNamePairs(
  codes: string[],
): Promise<Map<string, { de: string | null; en: string | null }>> {
  const pairs = new Map<string, { de: string | null; en: string | null }>();
  const filter = cpvStemFilter(codes);
  if (!filter) return pairs;

  const db = await getIngestionDb();
  const rows = await db
    .collection<{ code: string; name?: { en?: string; de?: string } }>("cpvcodes")
    .find(filter)
    .project<{ code: string; name?: { en?: string; de?: string } }>({ code: 1, name: 1 })
    .toArray();

  for (const row of rows) {
    pairs.set(stripCheckDigit(row.code), {
      de: row.name?.de ?? null,
      en: row.name?.en ?? null,
    });
  }
  return pairs;
}
