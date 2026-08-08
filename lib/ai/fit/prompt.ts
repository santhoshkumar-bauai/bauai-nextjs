import type { SerializedTenderDetail } from "../../tenders/detail.ts";
import type { RetrievedChunk } from "../retrieval/types.ts";
import type { ExtractionDocument } from "../types.ts";
import type { StoredCitedValue } from "../extraction/citations.ts";

/**
 * Fit-analysis prompt: the original tender/company comparison extended with
 * the company's own document evidence (tenant-scoped retrieval) and the
 * citation-verified facts extracted from the tender package. The output
 * schema (RECOMMENDATION_SCHEMA) is unchanged.
 */
export const FIT_PROMPT_VERSION = "fit-p2";

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildTenderSection(tender: SerializedTenderDetail): string {
  const buyerLocation = [
    tender.buyer?.address?.city,
    tender.buyer?.address?.postalCode,
    tender.buyer?.address?.countryCode,
  ]
    .filter(Boolean)
    .join(", ");

  return [
    `Title: ${tender.title ?? "—"}`,
    `Buyer: ${tender.buyer?.name ?? "—"} (${buyerLocation || "location unknown"})`,
    `Status: ${tender.status}`,
    `Procedure: ${tender.procedureType ?? "—"} / contract nature: ${tender.contractNature ?? "—"}`,
    `CPV codes: ${tender.cpvCodes.join(", ") || "—"}`,
    `NUTS regions: ${tender.regions.join(", ") || "—"}`,
    `Estimated value: ${tender.estimatedValue?.amount ?? "—"} ${tender.estimatedValue?.currency ?? ""}`.trim(),
    `Submission deadline: ${tender.submissionDeadline ?? "—"}`,
    `Description: ${truncate(tender.description, 1800)}`,
  ].join("\n");
}

export function buildEvidenceSection(chunks: RetrievedChunk[]): string | null {
  if (chunks.length === 0) return null;
  return chunks
    .map(
      (chunk) =>
        `[${chunk.fileName}]\n${truncate(chunk.text, 700)}`,
    )
    .join("\n\n");
}

/** Verified (or at least non-null) extraction facts, labeled with state. */
export function buildFactsSection(
  extractions: ExtractionDocument[],
): string | null {
  const lines: string[] = [];
  for (const extraction of extractions) {
    for (const [fieldName, raw] of Object.entries(extraction.fields)) {
      const field = raw as StoredCitedValue;
      if (field.value == null) continue;
      const marker = field.citationState === "VERIFIED" ? "verified" : "unverified";
      lines.push(
        `- ${extraction.schemaName}.${fieldName} = ${JSON.stringify(field.value)} (${marker}, confidence ${field.confidence})`,
      );
    }
  }
  if (lines.length === 0) return null;
  return lines.join("\n");
}

export function buildFitPrompt(input: {
  companyContext: string;
  tender: SerializedTenderDetail;
  evidence: RetrievedChunk[];
  extractions: ExtractionDocument[];
  locale: "en" | "de";
}): string {
  const languageLine =
    input.locale === "de"
      ? "Respond in German. Keep it professional and concise."
      : "Respond in English. Keep it professional and concise.";

  const evidenceSection = buildEvidenceSection(input.evidence);
  const factsSection = buildFactsSection(input.extractions);

  return [
    "You are a procurement bid-fit advisor for a company selling into German public tenders.",
    "Assess how well this tender fits the company, based ONLY on the material below.",
    "Weigh: scope/CPV overlap, geographic proximity, company size vs. contract value, required certifications and insurance vs. what the company holds, reference-project comparability, and time to deadline.",
    "Where VERIFIED TENDER FACTS conflict with the general description, trust the facts — they were extracted with verified citations.",
    "Be honest — recommend against tenders that are a poor fit. Do not invent facts.",
    languageLine,
    "",
    "=== COMPANY PROFILE ===",
    input.companyContext,
    ...(evidenceSection
      ? ["", "=== COMPANY EVIDENCE (from the company's own documents) ===", evidenceSection]
      : []),
    ...(factsSection
      ? ["", "=== VERIFIED TENDER FACTS (extracted with citations) ===", factsSection]
      : []),
    "",
    "=== TENDER ===",
    buildTenderSection(input.tender),
    "",
    "Return: an overall verdict, a 0-100 fitScore, a one-paragraph summary, and short bullet lists of strengths, concerns, and concrete suggested next actions.",
  ].join("\n");
}
