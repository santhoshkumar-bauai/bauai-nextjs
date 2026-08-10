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
 */
export async function resolveCpvNameMap(
  codes: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const stems = [...new Set(codes.map(stripCheckDigit).filter(Boolean))];
  if (stems.length === 0) return names;

  const db = await getIngestionDb();
  const rows = await db
    .collection<{ code: string; name?: { en?: string; de?: string } }>("cpvcodes")
    .find({ code: { $in: stems } })
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
