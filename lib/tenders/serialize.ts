/**
 * Client-facing shapes for ranked tenders. Aggregation already stringifies the
 * Decimal128 `estimatedValue.amount` (never JSON.stringify a raw Decimal128),
 * so this layer only flattens ids/dates into a plain, RSC-serializable object.
 */
import type { RankedTenderRaw } from "@/lib/tenders/relevance";

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
}

const round = (n: number) => Math.round((n ?? 0) * 1000) / 1000;

export function serializeTender(
  raw: RankedTenderRaw,
  extra?: {
    distanceKm?: number | null;
    categories?: string[];
    pipelineStatus?: string | null;
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
  };
}
