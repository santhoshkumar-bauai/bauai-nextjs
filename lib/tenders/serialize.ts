/**
 * Client-facing shapes for ranked tenders. Aggregation already stringifies the
 * Decimal128 `estimatedValue.amount` (never JSON.stringify a raw Decimal128),
 * so this layer only flattens ids/dates into a plain, RSC-serializable object.
 */
import type { RankedTenderRaw } from "@/lib/tenders/relevance";

/**
 * What the AI Matched feed adds on top of a ranked tender: the blended score,
 * and — the whole point — why this tender is here.
 *
 * An optional field on `SerializedTender` rather than a parallel type, so the
 * classic feed, the map and `tender-card.tsx` keep working untouched and the
 * card renders the AI block only when it is present.
 */
export interface AiMatchAnnotation {
  /** Blended retrieval score, 0..1. What the feed sorts on before judging. */
  matchScore: number;
  /** LLM fit 0..100; null until the judging phase runs (phase 2). */
  fitScore: number | null;
  confidence: "low" | "medium" | "high" | null;
  /** Already resolved to the requesting user's locale. */
  reason: string | null;
  matchedCapabilities: string[];
  concerns: string[];
  signals: { semantic: number; cpv: number; geo: number; time: number };
  /** Which parts of the company profile retrieved this tender. */
  matchedOn: Array<{ label: string | null; key: string; kind: "profile" | "document" }>;
  computedAt: string;
}

export interface SerializedTender {
  id: string;
  title: string | null;
  description: string | null;
  buyer: {
    name: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
  };
  cpvCodes: string[];
  regions: string[];
  status: string;
  submissionDeadline: string | null;
  publicationDate: string | null;
  estimatedValue: { amount: string | null; currency: string | null };
  score: number;
  scoreBreakdown: { cpv: number; geo: number; time: number };
  hasCoordinates: boolean;
  /**
   * Straight-line kilometres from the company. Null when either side has no
   * known coordinates — the list never geocodes to fill this in.
   */
  distanceKm: number | null;
  procedureType: string | null;
  contractNature: string | null;
  /** Human-readable CPV category names, resolved from the CPV catalog. */
  categories: string[];
  /** Set when the company already moved this tender into a kanban column. */
  pipelineStatus: string | null;
  sourceUrl: string | null;
  /** Present only in the AI Matched feed. */
  aiMatch?: AiMatchAnnotation | null;
}

const round = (n: number) => Math.round((n ?? 0) * 1000) / 1000;

export function serializeTender(
  raw: RankedTenderRaw,
  extra?: {
    distanceKm?: number | null;
    categories?: string[];
    pipelineStatus?: string | null;
    aiMatch?: AiMatchAnnotation | null;
  },
): SerializedTender {
  return {
    id: String(raw._id),
    title: raw.title ?? null,
    description: raw.description ?? null,
    buyer: {
      name: raw.buyer?.name ?? null,
      city: raw.buyer?.address?.city ?? null,
      postalCode: raw.buyer?.address?.postalCode ?? null,
      country: raw.buyer?.address?.countryCode ?? null,
    },
    cpvCodes: raw.cpvCodes ?? [],
    regions: raw.regions ?? [],
    status: raw.status,
    submissionDeadline: raw.submissionDeadline
      ? new Date(raw.submissionDeadline).toISOString()
      : null,
    publicationDate: raw.publicationDate
      ? new Date(raw.publicationDate).toISOString()
      : null,
    estimatedValue: {
      amount: raw.estimatedValueAmount ?? null,
      currency: raw.estimatedValueCurrency ?? null,
    },
    score: round(raw.score),
    scoreBreakdown: {
      cpv: round(raw.cpvScore),
      geo: round(raw.geoScore),
      time: round(raw.timeScore),
    },
    hasCoordinates: Boolean(raw.hasCoordinates),
    distanceKm: extra?.distanceKm ?? null,
    procedureType: raw.procedureType ?? null,
    contractNature: raw.contractNature ?? null,
    categories: extra?.categories ?? [],
    pipelineStatus: extra?.pipelineStatus ?? null,
    sourceUrl: raw.sourceUrl ?? null,
    ...(extra?.aiMatch !== undefined ? { aiMatch: extra.aiMatch } : {}),
  };
}
