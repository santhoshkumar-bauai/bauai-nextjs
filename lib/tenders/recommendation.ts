/**
 * On-demand AI fit analysis for a tender vs. the authenticated company.
 * Builds the Gemini prompt + a strict JSON response schema. The HTTP call lives
 * in the route (reusing the `app/api/cpv-map/route.ts` Gemini REST pattern).
 */
import type { SerializedTenderDetail } from "@/lib/tenders/detail";

export type FitVerdict =
  | "STRONG_FIT"
  | "POSSIBLE_FIT"
  | "WEAK_FIT"
  | "NOT_RECOMMENDED";

export const FIT_VERDICTS: FitVerdict[] = [
  "STRONG_FIT",
  "POSSIBLE_FIT",
  "WEAK_FIT",
  "NOT_RECOMMENDED",
];

export interface TenderRecommendation {
  verdict: FitVerdict;
  fitScore: number;
  summary: string;
  strengths: string[];
  concerns: string[];
  suggestedActions: string[];
}

/** Minimal company profile the model needs — extracted from the company doc. */
export interface CompanyProfileForAI {
  name?: string | null;
  businessDomain?: string | null;
  region?: string | null;
  services?: string[];
  cpvCodes?: string[];
  trade?: string[];
  specializations?: string[];
  certifications?: string[];
  employeeCount?: number | null;
  projectSizeRange?: { min?: string; max?: string } | null;
  capabilities?: string | null;
}

/** JSON schema handed to Gemini via `responseJsonSchema`. */
export const RECOMMENDATION_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: FIT_VERDICTS },
    fitScore: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" }, maxItems: 6 },
    concerns: { type: "array", items: { type: "string" }, maxItems: 6 },
    suggestedActions: { type: "array", items: { type: "string" }, maxItems: 6 },
  },
  required: [
    "verdict",
    "fitScore",
    "summary",
    "strengths",
    "concerns",
    "suggestedActions",
  ],
  additionalProperties: false,
} as const;

function truncate(text: string | null | undefined, max: number): string {
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildRecommendationPrompt(input: {
  company: CompanyProfileForAI;
  tender: SerializedTenderDetail;
  locale: "en" | "de";
}): string {
  const { company, tender, locale } = input;
  const languageLine =
    locale === "de"
      ? "Respond in German. Keep it professional and concise."
      : "Respond in English. Keep it professional and concise.";

  const companyLines = [
    `Name: ${company.name ?? "unspecified"}`,
    `Business domain: ${company.businessDomain ?? "unspecified"}`,
    `Region/base: ${company.region ?? "unspecified"}`,
    `Employees: ${company.employeeCount ?? "unspecified"}`,
    `Project size range: ${company.projectSizeRange?.min ?? "?"} – ${company.projectSizeRange?.max ?? "?"}`,
    `Services: ${(company.services ?? []).join(", ") || "—"}`,
    `Trades: ${(company.trade ?? []).join(", ") || "—"}`,
    `Specializations: ${(company.specializations ?? []).join(", ") || "—"}`,
    `Certifications: ${(company.certifications ?? []).join(", ") || "—"}`,
    `CPV codes: ${(company.cpvCodes ?? []).join(", ") || "—"}`,
    `Capabilities statement: ${truncate(company.capabilities, 800)}`,
  ].join("\n");

  const buyerLocation = [
    tender.buyer?.address?.city,
    tender.buyer?.address?.postalCode,
    tender.buyer?.address?.countryCode,
  ]
    .filter(Boolean)
    .join(", ");

  const tenderLines = [
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

  return [
    "You are a procurement bid-fit advisor for a construction-sector company.",
    "Assess how well this public tender fits the company, based ONLY on the facts below.",
    "Weigh: scope/CPV overlap, geographic proximity, company size vs. contract value, required certifications, and time to deadline.",
    "Be honest — recommend against tenders that are a poor fit. Do not invent facts not present below.",
    languageLine,
    "",
    "=== COMPANY PROFILE ===",
    companyLines,
    "",
    "=== TENDER ===",
    tenderLines,
    "",
    "Return: an overall verdict, a 0-100 fitScore, a one-paragraph summary, and short bullet lists of strengths, concerns, and concrete suggested next actions.",
  ].join("\n");
}

/** Validate/normalize a parsed model response into a safe recommendation. */
export function normalizeRecommendation(value: unknown): TenderRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const verdict = record.verdict;
  if (typeof verdict !== "string" || !FIT_VERDICTS.includes(verdict as FitVerdict)) {
    return null;
  }
  const fitScoreRaw = Number(record.fitScore);
  const fitScore = Number.isFinite(fitScoreRaw)
    ? Math.min(100, Math.max(0, Math.round(fitScoreRaw)))
    : 0;
  const toStringArray = (input: unknown): string[] =>
    Array.isArray(input)
      ? input.filter((item): item is string => typeof item === "string").slice(0, 6)
      : [];

  return {
    verdict: verdict as FitVerdict,
    fitScore,
    summary: typeof record.summary === "string" ? record.summary : "",
    strengths: toStringArray(record.strengths),
    concerns: toStringArray(record.concerns),
    suggestedActions: toStringArray(record.suggestedActions),
  };
}
