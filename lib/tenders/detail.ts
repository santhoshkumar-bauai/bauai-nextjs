/**
 * Full single-tender serialization for the detail modal. Unlike the list
 * serializer this keeps the whole description, buyer contact block, lots,
 * documents and schedule. Decimal128 (tender-level `estimatedValue`) and any
 * lot money are coerced to strings so nothing non-plain reaches the client.
 */
import type { CanonicalAddress, TenderDocument } from "@/lib/ingestion/types";

export interface SerializedMoney {
  amount: string | null;
  currency: string | null;
}

export interface SerializedAddress {
  streetName: string | null;
  city: string | null;
  postalCode: string | null;
  nutsCode: string | null;
  countryCode: string | null;
}

export interface SerializedTenderDocument {
  url: string;
  kind: string | null;
  language: string | null;
  restricted: boolean;
}

export interface SerializedLot {
  lotId: string;
  title: string | null;
  description: string | null;
  cpvCodes: string[];
  estimatedValue: SerializedMoney | null;
  submissionDeadline: string | null;
  deadlineKind: string | null;
  contractNature: string | null;
  locations: SerializedAddress[];
}

export interface SerializedTenderDetail {
  id: string;
  title: string | null;
  description: string | null;
  status: string;
  businessCategory: string;
  language: string | null;
  procedureType: string | null;
  contractNature: string | null;
  cpvCodes: string[];
  regions: string[];
  countries: string[];
  estimatedValue: SerializedMoney | null;
  publicationDate: string | null;
  submissionDeadline: string | null;
  buyer: {
    name: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
    legalType: string | null;
    activityType: string | null;
    address: SerializedAddress | null;
  } | null;
  lots: SerializedLot[];
  documents: SerializedTenderDocument[];
  sourceLinks: Array<{ source: string; url: string | null }>;
}

/** Coerce a Decimal128 / number / null money value to a plain string. */
function money(value: { amount: unknown; currency: string | null } | null): SerializedMoney | null {
  if (!value) return null;
  const amount = value.amount;
  return {
    amount: amount == null ? null : String(amount),
    currency: value.currency ?? null,
  };
}

function iso(date: Date | null | undefined): string | null {
  return date ? new Date(date).toISOString() : null;
}

function address(addr: CanonicalAddress | null): SerializedAddress | null {
  if (!addr) return null;
  return {
    streetName: addr.streetName ?? null,
    city: addr.city ?? null,
    postalCode: addr.postalCode ?? null,
    nutsCode: addr.nutsCode ?? null,
    countryCode: addr.countryCode ?? null,
  };
}

export function serializeTenderDetail(
  raw: TenderDocument,
): SerializedTenderDetail {
  return {
    id: String(raw._id),
    title: raw.title ?? null,
    description: raw.description ?? null,
    status: raw.status,
    businessCategory: raw.businessCategory,
    language: raw.language ?? null,
    procedureType: raw.procedureType ?? null,
    contractNature: raw.contractNature ?? null,
    cpvCodes: raw.cpvCodes ?? [],
    regions: raw.regions ?? [],
    countries: raw.countries ?? [],
    estimatedValue: money(raw.estimatedValue),
    publicationDate: iso(raw.publicationDate),
    submissionDeadline: iso(raw.submissionDeadline),
    buyer: raw.buyer
      ? {
          name: raw.buyer.name ?? null,
          email: raw.buyer.email ?? null,
          phone: raw.buyer.phone ?? null,
          website: raw.buyer.website ?? null,
          legalType: raw.buyer.legalType ?? null,
          activityType: raw.buyer.activityType ?? null,
          address: address(raw.buyer.address),
        }
      : null,
    lots: (raw.lots ?? []).map((lot) => ({
      lotId: lot.lotId,
      title: lot.title ?? null,
      description: lot.description ?? null,
      cpvCodes: lot.cpvCodes ?? [],
      estimatedValue: money(lot.estimatedValue),
      submissionDeadline: iso(lot.submissionDeadline),
      deadlineKind: lot.deadlineKind ?? null,
      contractNature: lot.contractNature ?? null,
      locations: (lot.locations ?? []).map((loc) => address(loc)!).filter(Boolean),
    })),
    documents: (raw.documents ?? []).map((doc) => ({
      url: doc.url,
      kind: doc.kind ?? null,
      language: doc.language ?? null,
      restricted: Boolean(doc.restricted),
    })),
    sourceLinks: (raw.sourceLinks ?? []).map((link) => ({
      source: link.source,
      url: link.url ?? null,
    })),
  };
}
