/**
 * Extraction schema names as a standalone, dependency-free module: the full
 * registry (schemas/index.ts) pulls in zod + node:crypto via the citation
 * contract, which client components must not bundle.
 */
export const EXTRACTION_SCHEMA_NAMES = [
  "deadlines",
  "suitability_criteria",
  "award_criteria",
  "required_proofs",
  "contractual_penalties",
  "payment_terms",
  "alternative_bids",
] as const;

export type ExtractionSchemaName = (typeof EXTRACTION_SCHEMA_NAMES)[number];
