/**
 * Canonical retrieval questions (roadmap §17.5). Each question carries an
 * expectation the retrieved chunks are graded against: a chunk "answers" the
 * question when any pattern matches its text (or, for legalRef type, its
 * extracted legal references). Deliberately recall-oriented — the harness
 * measures whether the relevant material surfaces at all, not answer quality.
 */

export type ExpectationType = "regex" | "legalRef";

export interface CanonicalQuestion {
  id: string;
  /** German phrasing — the corpus language. */
  de: string;
  /** English phrasing — tests cross-lingual embedding behavior. */
  en: string;
  expectation: {
    type: ExpectationType;
    /** For regex: any match counts. Case-insensitive. */
    patterns: string[];
  };
}

export const CANONICAL_QUESTIONS: CanonicalQuestion[] = [
  {
    id: "submission-deadline",
    de: "Wann endet die Angebotsfrist?",
    en: "What is the submission deadline?",
    expectation: {
      type: "regex",
      patterns: [
        "angebotsfrist",
        "abgabefrist",
        "einreichungsfrist",
        "frist.{0,40}(angebot|abgabe)",
        "(angebot|abgabe).{0,40}frist",
        "\\d{1,2}\\.\\d{1,2}\\.\\d{4}.{0,30}uhr",
      ],
    },
  },
  {
    id: "required-references",
    de: "Welche Referenzen werden gefordert?",
    en: "Which references are required?",
    expectation: {
      type: "regex",
      patterns: ["referenz", "vergleichbare leistung", "referenzprojekt"],
    },
  },
  {
    id: "insurance-coverage",
    de: "Welche Versicherungen bzw. welche Deckungssummen werden verlangt?",
    en: "What insurance coverage is required?",
    expectation: {
      type: "regex",
      patterns: [
        "versicherung",
        "haftpflicht",
        "deckungssumme",
        "berufshaftpflicht",
      ],
    },
  },
  {
    id: "alternative-bids",
    de: "Sind Nebenangebote zugelassen?",
    en: "Are alternative bids allowed?",
    expectation: {
      type: "regex",
      patterns: ["nebenangebot", "nebenangebote"],
    },
  },
  {
    id: "contract-penalties",
    de: "Welche Vertragsstrafen sind vorgesehen?",
    en: "What contractual penalties apply?",
    expectation: {
      type: "regex",
      patterns: ["vertragsstrafe", "pönale", "verzugsstrafe"],
    },
  },
  {
    id: "legal-ref-vob-13",
    de: "Was gilt nach § 13 VOB/B in diesen Unterlagen?",
    en: "What does § 13 VOB/B say in this package?",
    expectation: {
      type: "legalRef",
      patterns: ["§ 13 VOB/B"],
    },
  },
  {
    id: "required-documents",
    de: "Welche Unterlagen und Nachweise sind mit dem Angebot einzureichen?",
    en: "Which required documents must be submitted?",
    expectation: {
      type: "regex",
      patterns: [
        "einzureichen",
        "nachweis",
        "eigenerklärung",
        "vorzulegen",
        "beizufügen",
      ],
    },
  },
];
