import type { ExtractionSchemaName } from "./schemas/index.ts";

/**
 * Retrieval query sets per schema for the retrieval-targeted extraction path.
 * German queries carry recall through the lucene.german keyword arm (the
 * corpus is German); one English variant per schema exercises the
 * cross-lingual vector arm as a safety net.
 */
export const SCHEMA_QUERIES: Record<ExtractionSchemaName, string[]> = {
  deadlines: [
    "Angebotsfrist Abgabefrist Einreichung des Angebots",
    "Bindefrist Zuschlagsfrist",
    "Eröffnungstermin Submission",
    "Ausführungsfristen Ausführungsbeginn Fertigstellung",
    "submission deadline bid validity",
  ],
  suitability_criteria: [
    "Eignung Eignungskriterien technische Leistungsfähigkeit",
    "Referenzen vergleichbare Leistungen",
    "Mindestjahresumsatz wirtschaftliche Leistungsfähigkeit",
    "Deckungssumme Haftpflichtversicherung Nachweis",
    "supplier suitability qualification requirements",
  ],
  award_criteria: [
    "Zuschlagskriterien Wertungskriterien Gewichtung",
    "Wertung der Angebote Wertungsmethode",
    "niedrigster Preis wirtschaftlichstes Angebot",
    "award criteria weighting price quality",
  ],
  required_proofs: [
    "Nachweise Eigenerklärungen mit dem Angebot einzureichen",
    "vorzulegende Unterlagen auf Verlangen",
    "Präqualifikation PQ-Verzeichnis",
    "required documents evidence certificates",
  ],
  contractual_penalties: [
    "Vertragsstrafe Überschreitung Vertragsfristen",
    "Pönale Verzugsstrafe Obergrenze",
    "contractual penalty delay damages",
  ],
  payment_terms: [
    "Zahlungsbedingungen Zahlungsziel Rechnung",
    "Sicherheitseinbehalt Gewährleistungssicherheit",
    "Skonto Abschlagszahlungen",
    "payment terms retention invoicing",
  ],
  alternative_bids: [
    "Nebenangebote zugelassen nicht zugelassen",
    "Anforderungen an Nebenangebote",
    "alternative bids variants allowed",
  ],
};
