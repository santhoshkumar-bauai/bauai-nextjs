import { z } from "zod";

/**
 * Document classes for German tender packages (roadmap §15.3, English
 * identifiers per project convention — docs/GLOSSARY.md maps each to the
 * German term it appears as in real documents).
 */
export const DOC_CLASSES = [
  "tender_notice",
  "conditions_of_participation",
  "contract_conditions",
  "bill_of_quantities",
  "price_sheet",
  "suitability_proof_form",
  "award_matrix",
  "deadline_schedule",
  "technical_specification",
  "standard_form",
  "annex",
  "unknown",
] as const;

export type DocClass = (typeof DOC_CLASSES)[number];

export const docClassSchema = z.enum(DOC_CLASSES);

/**
 * English → German meaning, used by the LLM-fallback prompt so the model and
 * the glossary can never drift apart silently.
 */
export const DOC_CLASS_MEANINGS: Record<DocClass, string> = {
  tender_notice: "Bekanntmachung — the published tender notice itself",
  conditions_of_participation:
    "Bewerbungsbedingungen / Teilnahmebedingungen — how to apply or bid; deadlines and required proofs",
  contract_conditions:
    "Vertragsbedingungen (BVB/ZVB/AVB) / Vertragsentwurf — draft contract; penalties and payment terms",
  bill_of_quantities:
    "Leistungsverzeichnis (LV) / Leistungsbeschreibung — itemized scope of works, basis for pricing",
  price_sheet: "Preisblatt — form the bidder fills with prices",
  suitability_proof_form:
    "Eignungsnachweis-Formular / Eigenerklärung zur Eignung — form for declaring suitability facts",
  award_matrix:
    "Zuschlagsmatrix / Wertungsmatrix — scoring and weighting table for bid evaluation",
  deadline_schedule: "Fristen-/Terminplan / Bauzeitenplan — milestone and deadline listing",
  technical_specification:
    "Technische Spezifikation / Baubeschreibung — technical requirements",
  standard_form: "Formblatt (VHB/EFB numbered forms, e.g. 124, 213) — official standard forms",
  annex: "Anlage — generic attachment",
  unknown: "cannot be determined from the available information",
};
