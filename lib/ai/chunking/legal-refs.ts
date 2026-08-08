/**
 * German legal-reference detection (roadmap §16.2). References like
 * "§ 13 VOB/B" must be exact-match retrievable: embeddings cannot reliably
 * distinguish § 13 from § 14, so chunks carry them as normalized keywords
 * indexed as Lucene tokens.
 */

const LEGAL_REF = new RegExp(
  // § or §§, number with optional letter suffix, optional Abs./Nr. qualifiers,
  // then the code (VOB/A, VOB/B, VgV, GWB, UVgO, HOAI, BGB, VwVfG).
  "§{1,2}\\s*(\\d+[a-z]?)\\s*" +
    "(?:Abs\\.?\\s*(\\d+)\\s*)?" +
    "(?:Nr\\.?\\s*(\\d+)\\s*)?" +
    "(VOB/[AB]|VgV|GWB|UVgO|HOAI|BGB|VwVfG)",
  "g",
);

/**
 * Extracts and normalizes legal references from a text. Output is stable and
 * deduplicated: "§13 Abs. 2 VOB/B" → "§ 13 Abs. 2 VOB/B".
 */
export function extractLegalRefs(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(LEGAL_REF)) {
    const [, paragraph, absatz, nummer, code] = match;
    let ref = `§ ${paragraph}`;
    if (absatz) ref += ` Abs. ${absatz}`;
    if (nummer) ref += ` Nr. ${nummer}`;
    ref += ` ${code}`;
    found.add(ref);
  }
  return [...found];
}
