import { z } from "zod";

import { citedValue } from "../citations.ts";

/**
 * The pilot extraction schemas (roadmap §18.1, English identifiers per
 * project convention — docs/GLOSSARY.md maps each to its German term).
 * Model output shape per schema: { fields: {...}, unresolved: string[] } —
 * `unresolved` is a first-class legal answer (§18.3).
 *
 * Versioning: bump `schemaVersion` on any field change; the version is part
 * of the extraction idempotency key, so a bump triggers re-extraction.
 */

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/, "ISO-8601 date or datetime");

function extractionOutput<F extends z.ZodRawShape>(fields: F) {
  return z.object({
    fields: z.object(fields),
    unresolved: z
      .array(z.string())
      .describe("names of fields whose value could not be found in the sources"),
  });
}

/* ------------------------------- deadlines ------------------------------- */

const deadlinesFields = {
  submissionDeadline: citedValue(
    isoDateTime,
    "Bid submission deadline (Angebotsfrist/Abgabefrist), ISO-8601 with Europe/Berlin offset",
  ),
  questionDeadline: citedValue(
    isoDateTime,
    "Deadline for bidder questions (Frist für Bieterfragen/Rückfragen)",
  ),
  bindingPeriodEnd: citedValue(
    isoDateTime,
    "End of the bid validity period (Bindefrist/Zuschlagsfrist) as a date",
  ),
  bindingPeriodDays: citedValue(
    z.number().int(),
    "Bid validity period (Bindefrist) as a number of days, when stated as a duration",
  ),
  openingDate: citedValue(
    isoDateTime,
    "Bid opening date (Eröffnungstermin/Submissionstermin)",
  ),
  executionStart: citedValue(isoDateTime, "Planned start of execution (Ausführungsbeginn)"),
  executionEnd: citedValue(isoDateTime, "Planned end of execution (Ausführungsende/Fertigstellung)"),
};

/* -------------------------- suitability_criteria ------------------------- */

const suitabilityFields = {
  minReferenceCount: citedValue(
    z.number().int(),
    "Minimum number of comparable reference projects required (Referenzen)",
  ),
  referenceRequirements: citedValue(
    z.string(),
    "Requirements the references must satisfy: comparability, age, scope (Anforderungen an Referenzen)",
  ),
  minAnnualRevenueEur: citedValue(
    z.number(),
    "Minimum annual revenue in EUR (Mindestjahresumsatz)",
  ),
  requiredCertifications: citedValue(
    z.array(z.string()),
    "Required certifications or qualifications, e.g. PQ-Nachweis, ISO 9001 (Zertifikate)",
  ),
  requiredStaffQualifications: citedValue(
    z.string(),
    "Required staff qualifications (Qualifikation des Personals)",
  ),
  registrationRequirements: citedValue(
    z.string(),
    "Registry requirements: Handelsregister, Handwerksrolle, Berufsregister",
  ),
  minLiabilityCoverageEur: citedValue(
    z.number(),
    "Minimum liability insurance coverage in EUR (Deckungssumme der Haftpflichtversicherung)",
  ),
};

/* ----------------------------- award_criteria ---------------------------- */

const awardFields = {
  criteria: citedValue(
    z.array(
      z.object({
        name: z.string(),
        weightPercent: z.number().nullable(),
      }),
    ),
    "Award criteria with weighting percentages (Zuschlagskriterien mit Gewichtung)",
  ),
  priceWeightPercent: citedValue(
    z.number(),
    "Weight of the price criterion in percent (Gewichtung Preis)",
  ),
  evaluationMethod: citedValue(
    z.string(),
    "Evaluation method, e.g. einfache Richtwertmethode, UfAB (Wertungsmethode)",
  ),
  priceOnly: citedValue(
    z.boolean(),
    "True when award goes to the lowest price only (niedrigster Preis)",
  ),
};

/* ---------------------------- required_proofs ---------------------------- */

const proofKind = z.enum([
  "certificate",
  "self_declaration",
  "registry_extract",
  "insurance",
  "reference",
  "other",
]);

const requiredProofsFields = {
  proofs: citedValue(
    z.array(
      z.object({
        name: z.string(),
        kind: proofKind,
        mandatory: z.boolean().nullable(),
        due: z.enum(["with_bid", "on_request"]).nullable(),
      }),
    ),
    "Proofs the bidder must furnish (Nachweise/Eigenerklärungen), with kind and when they are due",
  ),
  preQualificationAccepted: citedValue(
    z.boolean(),
    "True when pre-qualification replaces individual proofs (PQ-Verzeichnis ersetzt Einzelnachweise)",
  ),
};

/* -------------------------- contractual_penalties ------------------------ */

const penaltiesFields = {
  delayPenaltyPercentPerDay: citedValue(
    z.number(),
    "Delay penalty as percent of contract sum per working day (Vertragsstrafe je Werktag)",
  ),
  delayPenaltyPercentPerWeek: citedValue(
    z.number(),
    "Delay penalty as percent per week (Vertragsstrafe je Woche)",
  ),
  penaltyCapPercent: citedValue(
    z.number(),
    "Maximum total penalty as percent of contract sum (Obergrenze der Vertragsstrafe)",
  ),
  penaltyClauses: citedValue(
    z.array(
      z.object({
        text: z.string(),
        legalRef: z.string().nullable(),
      }),
    ),
    "Penalty clauses verbatim with their legal reference where given",
  ),
};

/* ----------------------------- payment_terms ----------------------------- */

const paymentFields = {
  paymentDeadlineDays: citedValue(
    z.number().int(),
    "Payment deadline in days (Zahlungsziel)",
  ),
  retentionPercent: citedValue(
    z.number(),
    "Security retention as percent (Sicherheitseinbehalt)",
  ),
  warrantyRetentionPercent: citedValue(
    z.number(),
    "Warranty retention as percent (Gewährleistungssicherheit)",
  ),
  earlyPaymentDiscountPercent: citedValue(
    z.number(),
    "Early-payment discount percent (Skonto)",
  ),
  earlyPaymentDiscountDays: citedValue(
    z.number().int(),
    "Days within which payment earns the discount (Skontofrist)",
  ),
  invoicingRules: citedValue(
    z.string(),
    "Invoicing requirements, e.g. XRechnung, submission portal (Rechnungsstellung)",
  ),
  partialPaymentsAllowed: citedValue(
    z.boolean(),
    "True when progress payments are allowed (Abschlagszahlungen)",
  ),
};

/* ---------------------------- alternative_bids --------------------------- */

const alternativeBidsFields = {
  alternativeBidsAllowed: citedValue(
    z.boolean(),
    "True when alternative/variant bids are permitted (Nebenangebote zugelassen)",
  ),
  conditions: citedValue(
    z.string(),
    "Conditions alternative bids must satisfy (Anforderungen an Nebenangebote)",
  ),
};

/* ------------------------------- registry -------------------------------- */

export {
  EXTRACTION_SCHEMA_NAMES,
  type ExtractionSchemaName,
} from "../schema-names.ts";
import type { ExtractionSchemaName } from "../schema-names.ts";

export interface ExtractionSchemaEntry {
  name: ExtractionSchemaName;
  schemaVersion: number;
  /** German term, for prompts and docs. */
  germanTerm: string;
  zod: z.ZodType;
  jsonSchema: Record<string, unknown>;
  fieldNames: string[];
}

function entry(
  name: ExtractionSchemaName,
  germanTerm: string,
  fields: z.ZodRawShape,
): ExtractionSchemaEntry {
  const zodSchema = extractionOutput(fields);
  return {
    name,
    schemaVersion: 1,
    germanTerm,
    zod: zodSchema,
    jsonSchema: z.toJSONSchema(zodSchema, { target: "draft-7" }) as Record<string, unknown>,
    fieldNames: Object.keys(fields),
  };
}

export const EXTRACTION_SCHEMAS: Record<ExtractionSchemaName, ExtractionSchemaEntry> = {
  deadlines: entry("deadlines", "Fristen", deadlinesFields),
  suitability_criteria: entry("suitability_criteria", "Eignungskriterien", suitabilityFields),
  award_criteria: entry("award_criteria", "Zuschlagskriterien", awardFields),
  required_proofs: entry("required_proofs", "Nachweise", requiredProofsFields),
  contractual_penalties: entry("contractual_penalties", "Vertragsstrafen", penaltiesFields),
  payment_terms: entry("payment_terms", "Zahlungsbedingungen", paymentFields),
  alternative_bids: entry("alternative_bids", "Nebenangebote", alternativeBidsFields),
};
