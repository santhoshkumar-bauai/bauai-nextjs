import { resolveCpvNamePairs } from "../ai/match/cpv.ts";

/**
 * A company profile rendered as weighted search terms.
 *
 * This is the cold-start path: a company that has just signed up has no
 * uploaded documents and therefore no embeddings, and the only description of
 * it we hold is what onboarding collected — services, trade, specializations,
 * a business domain, and a handful of CPV codes.
 *
 * The CPV codes are used here as *vocabulary*, never as a filter. That
 * distinction is the whole point. Matching code-to-code requires the tender to
 * carry a correct code, and it frequently does not: 14% of open tenders have
 * no CPV at all, and plenty of the rest sit under a division picked by whoever
 * filed the notice. Resolving the company's own codes to their catalog names
 * turns "45310000" into "Installation von elektrischen Leitungen" — words that
 * hit the notice body directly, whatever the tender was filed under.
 */

/** Weights fed to the `$search` compound clauses. */
const W_SPECIALIZATION = 3;
const W_TRADE = 2.5;
const W_SERVICE = 2;
const W_CPV_NAME = 1.5;
const W_DOMAIN = 0.5;

/**
 * Terms shorter than this are dropped. German compounds carry the meaning; a
 * three-letter fragment matches half the corpus and ranks noise to the top.
 */
const MIN_TERM_CHARS = 4;

/**
 * Longest term kept, in words.
 *
 * CPV catalog names are descriptive sentences, not search terms — "Engineering
 * design services for mechanical and electrical installations for buildings".
 * Sent to an analyzer whole, the filler tokens ("services", "for", "works")
 * match every consultancy notice in the corpus, and measurably did: unbounded,
 * an electrical profile ranked "Feasibility Study for an African Railway
 * Competence Centre" in its top ten. Segment first, then cap.
 */
const MAX_TERM_WORDS = 4;

/** Where a catalog name splits into independently meaningful parts. */
const SEGMENT_SPLIT =
  /\s*(?:,|;|\/|\bsowie\b|\bund\b|\boder\b|\band\b|\bor\b|\bfor\b|\bof\b)\s*/gi;

/**
 * Tokens that carry no discriminating power in a tender corpus. A segment made
 * only of these is dropped — every notice is "Arbeiten", so ranking by it
 * ranks by nothing.
 */
const GENERIC_TOKENS = new Set([
  "arbeiten",
  "leistungen",
  "dienstleistungen",
  "zugehörige",
  "sonstige",
  "verschiedene",
  "diverse",
  "bau",
  "bauarbeiten",
  "work",
  "works",
  "services",
  "service",
  "related",
  "other",
  "various",
  "miscellaneous",
  "general",
  "complete",
  "part",
  "buildings",
  "gebäude",
]);

/**
 * A catalog name reduced to the parts worth searching for. Segments are capped
 * at `MAX_TERM_WORDS` and dropped when nothing in them discriminates.
 */
export function segmentCatalogName(name: string): string[] {
  return name
    .split(SEGMENT_SPLIT)
    .map((segment) => normalize(segment))
    .filter((segment) => {
      if (segment.length < MIN_TERM_CHARS) return false;
      // German compound ellipsis: "Komplett- oder Teilbauleistungen" splits
      // into a dangling prefix, and the German analyzer happily stems
      // "Komplett-" onto "Komplettsanierung". That one fragment put four
      // heating and ventilation lots at the top of a bridge-builder's feed.
      // The full compound survives in the other half of the split.
      if (/[-–]$/.test(segment)) return false;
      const words = segment.split(" ");
      if (words.length > MAX_TERM_WORDS) return false;
      return words.some((word) => !GENERIC_TOKENS.has(word.toLowerCase()));
    });
}

/** Per-query ceiling. Past this, added clauses only blur the ranking. */
export const MAX_TERMS = 60;

/**
 * CPV divisions so broad that their catalog name is a tautology for the whole
 * corpus. "Bauarbeiten" matches every construction notice ever published, so
 * as a scoring term it carries no information and it crowds out the specific
 * ones. Dropped from the term set; they still work as filters elsewhere.
 */
const GENERIC_CPV_STEMS = new Set(["45", "44", "71", "50", "34", "90", "79"]);

export interface ProfileTerm {
  text: string;
  weight: number;
  source: "specialization" | "trade" | "service" | "cpv" | "domain";
}

export interface ProfileTermsInput {
  services?: string[] | null;
  trade?: string[] | null;
  specializations?: string[] | null;
  businessDomain?: string | null;
  cpvCodes?: string[] | null;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * `CONSTRUCTION` and `civil_engineering` are enum values, not language. Left
 * as-is they never match a German notice; as words they at least contribute.
 */
function humanizeDomain(domain: string): string {
  return normalize(domain.replace(/[_-]+/g, " ").toLowerCase());
}

function push(
  into: Map<string, ProfileTerm>,
  text: string | null | undefined,
  weight: number,
  source: ProfileTerm["source"],
): void {
  if (!text) return;
  const clean = normalize(text);
  if (clean.length < MIN_TERM_CHARS) return;

  // Free-text profile fields run long too ("Planung und Bauüberwachung von
  // Elektroanlagen"). Same treatment as a catalog name rather than a hard
  // drop, so the useful half of the phrase survives.
  if (clean.split(" ").length > MAX_TERM_WORDS) {
    for (const segment of segmentCatalogName(clean)) {
      push(into, segment, weight, source);
    }
    return;
  }

  // Case-insensitive dedupe, keeping the strongest weight: a term that is both
  // a declared specialization and a CPV name should score as the former.
  const key = clean.toLowerCase();
  const existing = into.get(key);
  if (existing && existing.weight >= weight) return;
  into.set(key, { text: clean, weight, source });
}

/**
 * Build the term set. Pure apart from the CPV catalog read, and that read is
 * the only reason this is async — everything else is already on the company.
 */
export async function buildProfileTerms(
  company: ProfileTermsInput,
): Promise<ProfileTerm[]> {
  const terms = new Map<string, ProfileTerm>();

  for (const value of company.specializations ?? []) {
    push(terms, value, W_SPECIALIZATION, "specialization");
  }
  for (const value of company.trade ?? []) push(terms, value, W_TRADE, "trade");
  for (const value of company.services ?? []) {
    push(terms, value, W_SERVICE, "service");
  }

  const codes = (company.cpvCodes ?? []).filter(Boolean);
  if (codes.length) {
    const pairs = await resolveCpvNamePairs(codes);
    for (const [stem, name] of pairs) {
      const significant = stem.replace(/0+$/, "");
      if (significant.length <= 2 && GENERIC_CPV_STEMS.has(significant)) continue;
      // German first — it is the one with a real chance against a German
      // notice body — but both go in, because the corpus is not only German.
      for (const label of [name.de, name.en]) {
        if (!label) continue;
        for (const segment of segmentCatalogName(label)) {
          push(terms, segment, W_CPV_NAME, "cpv");
        }
      }
    }
  }

  if (company.businessDomain) {
    push(terms, humanizeDomain(company.businessDomain), W_DOMAIN, "domain");
  }

  return [...terms.values()]
    .sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text))
    .slice(0, MAX_TERMS);
}

/** Whether there is enough profile here for the lexical arm to mean anything. */
export function hasUsableTerms(terms: ProfileTerm[]): boolean {
  // A lone humanized business domain is not a profile — "construction" alone
  // ranks the corpus by how often it says "Bau", which is not a match.
  return terms.some((term) => term.source !== "domain");
}
