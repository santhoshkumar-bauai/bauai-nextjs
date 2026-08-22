import type { DocClass } from "./doc-classes.ts";

/**
 * Heuristic document classification: filename first, then the head of the
 * extracted text. Rules are ordered — the first hit wins — so the specific
 * beats the generic (a "Formblatt 124 Eigenerklärung" is a suitability form,
 * not just any standard form; an "Anlage 3 Leistungsverzeichnis" is an LV,
 * not an annex). Returns null when nothing fires; the LLM fallback decides.
 *
 * Patterns are German because the documents are German (docs/GLOSSARY.md).
 */

export interface HeuristicResult {
  docClass: DocClass;
  confidence: number;
  /** Which rule fired — kept on the classification record for debuggability. */
  rule: string;
}

interface Rule {
  name: string;
  docClass: DocClass;
  pattern: RegExp;
  /** Rules that only make sense against the filename. */
  filenameOnly?: boolean;
}

/** Ordered: most specific first. */
const RULES: Rule[] = [
  // Suitability declaration forms before generic standard forms: "124" is the
  // canonical VHB Eigenerklärung zur Eignung.
  {
    name: "suitability-form",
    docClass: "suitability_proof_form",
    pattern: /eignungsnachweis|eigenerkl(ä|ae)rung\s+zur\s+eignung|formblatt\s*124\b|\b124\s*(LD|L)\b/i,
  },
  {
    name: "award-matrix",
    docClass: "award_matrix",
    pattern: /zuschlagsmatrix|wertungsmatrix|bewertungsmatrix|wertungskriterien|zuschlagskriterien/i,
  },
  {
    name: "conditions-of-participation",
    docClass: "conditions_of_participation",
    pattern:
      /bewerbungsbedingungen|teilnahmebedingungen|bewerbungsbogen|aufforderung\s+zur\s+(abgabe|angebotsabgabe)|angebotsaufforderung|teilnahmewettbewerb/i,
  },
  {
    name: "contract-conditions",
    docClass: "contract_conditions",
    pattern:
      /(besondere|zus(ä|ae)tzliche|allgemeine|erg(ä|ae)nzende)\s+vertragsbedingungen|\b(BVB|ZVB|EVB|AVB)\b|vertragsentwurf|vertragsmuster|bauvertrag|werkvertrag|rahmenvertrag|EVB-IT/i,
  },
  {
    name: "bill-of-quantities",
    docClass: "bill_of_quantities",
    pattern:
      /leistungsverzeichnis|leistungsbeschreibung|\bLV\b|\bGAEB\b|\.[xdp]8[1-6]\b|leistungsprogramm/i,
  },
  {
    name: "price-sheet",
    docClass: "price_sheet",
    pattern: /preisblatt|preisspiegel|preisliste|preisformular|angebotsblatt|EFB[- ]?Preis|\b22[1-3]\b/i,
  },
  {
    name: "deadline-schedule",
    docClass: "deadline_schedule",
    pattern: /terminplan|fristenplan|bauzeitenplan|terminübersicht|zeitplan|bauablaufplan/i,
  },
  {
    name: "technical-spec",
    docClass: "technical_specification",
    pattern:
      /technische\s+spezifikation|baubeschreibung|technische\s+vorbemerkungen|leistungsprofil|pflichtenheft|lastenheft/i,
  },
  {
    name: "tender-notice",
    docClass: "tender_notice",
    pattern:
      /bekanntmachung|auftragsbekanntmachung|vergabebekanntmachung|eforms|ex[- ]?ante|\bted\b.*notice|notice.*\bted\b/i,
  },
  // Generic standard forms after every specific numbered form above.
  {
    name: "standard-form",
    docClass: "standard_form",
    pattern: /formblatt|\bVHB\b|\bEFB\b|\bHVA\b\s*[BFL]|formular\s*\d{3}\b|\b(21[1-9]|63[1-5]|felb)\b/i,
  },
  // Annex is filename-only and last: body text saying "siehe Anlage 3" must
  // not classify the whole document as an annex.
  {
    name: "annex",
    docClass: "annex",
    pattern: /^anlage\s*\d*/i,
    filenameOnly: true,
  },
];

const FILENAME_CONFIDENCE = 0.9;
const TEXT_CONFIDENCE = 0.8;
const ANNEX_CONFIDENCE = 0.6;

/** How much of the document head is considered; headings live up front. */
const TEXT_HEAD_CHARS = 3000;

/**
 * Filenames separate words with underscores/hyphens, which are word
 * characters in JS regex — `\s+` and `\b` silently fail on
 * "Besondere_Vertragsbedingungen_BVB.pdf". Normalizing them to spaces lets
 * the patterns stay readable. Dots are kept for extension rules (.x83).
 */
function normalizeSeparators(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

export function classifyByHeuristics(input: {
  fileName: string;
  firstPageText: string;
}): HeuristicResult | null {
  const fileName = normalizeSeparators(input.fileName);
  const head = normalizeSeparators(input.firstPageText.slice(0, TEXT_HEAD_CHARS));

  for (const rule of RULES) {
    if (rule.pattern.test(fileName)) {
      return {
        docClass: rule.docClass,
        confidence: rule.docClass === "annex" ? ANNEX_CONFIDENCE : FILENAME_CONFIDENCE,
        rule: `${rule.name}:filename`,
      };
    }
  }

  for (const rule of RULES) {
    if (rule.filenameOnly) continue;
    if (rule.pattern.test(head)) {
      return {
        docClass: rule.docClass,
        confidence: TEXT_CONFIDENCE,
        rule: `${rule.name}:text`,
      };
    }
  }

  return null;
}
