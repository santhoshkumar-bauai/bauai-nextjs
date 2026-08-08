import { createHash } from "node:crypto";

import type { Decimal128 } from "mongodb";

import type { TenderDocument } from "../../ingestion/types.ts";
import type { TenderSearchDocument } from "../types.ts";

/**
 * Builds the curated searchable representation of a tender notice (§12.2).
 * The embedded text is a compact, human-readable digest — never serialized
 * MongoDB JSON (§17.2): field noise ("_id", "aggregateVersion", …) measurably
 * degrades embedding quality.
 */

const MAX_DESCRIPTION_CHARS = 4000;
const MAX_LOTS = 10;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function decimalToNumber(value: Decimal128 | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : null;
}

export interface BuiltSearchDocument {
  text: string;
  language: string | null;
  filters: TenderSearchDocument["filters"];
  sourceHash: string;
}

export function buildSearchDocument(tender: TenderDocument): BuiltSearchDocument {
  const lines: string[] = [];

  if (tender.title) lines.push(`Title: ${tender.title}`);
  if (tender.buyer?.name) {
    const city = tender.buyer.address?.city;
    lines.push(`Buyer: ${tender.buyer.name}${city ? `, ${city}` : ""}`);
  }
  if (tender.cpvCodes.length) lines.push(`CPV: ${tender.cpvCodes.join(", ")}`);
  if (tender.regions.length || tender.countries.length) {
    lines.push(
      `Region: ${[...tender.countries, ...tender.regions].join(", ")}`,
    );
  }
  if (tender.procedureType) lines.push(`Procedure: ${tender.procedureType}`);
  if (tender.contractNature) lines.push(`Contract nature: ${tender.contractNature}`);

  const value = decimalToNumber(tender.estimatedValue?.amount ?? null);
  if (value != null) {
    lines.push(
      `Estimated value: ${value} ${tender.estimatedValue?.currency ?? ""}`.trim(),
    );
  }
  if (tender.submissionDeadline) {
    lines.push(`Deadline: ${tender.submissionDeadline.toISOString().slice(0, 10)}`);
  }
  if (tender.description) {
    lines.push(`Description: ${truncate(tender.description, MAX_DESCRIPTION_CHARS)}`);
  }

  const lots = tender.lots.slice(0, MAX_LOTS);
  for (const [index, lot] of lots.entries()) {
    const parts = [lot.title, lot.description ? truncate(lot.description, 400) : null]
      .filter(Boolean)
      .join(" — ");
    if (parts) lines.push(`Lot ${index + 1}: ${parts}`);
  }
  if (tender.lots.length > MAX_LOTS) {
    lines.push(`(${tender.lots.length - MAX_LOTS} further lots omitted)`);
  }

  const text = lines.join("\n");

  return {
    text,
    language: tender.language,
    filters: {
      status: tender.status,
      businessCategory: tender.businessCategory ?? null,
      cpvCodes: tender.cpvCodes,
      countryCodes: tender.countries,
      regionCodes: tender.regions,
      procedureType: tender.procedureType,
      contractNature: tender.contractNature,
      estimatedValueAmount: value,
      submissionDeadline: tender.submissionDeadline,
    },
    sourceHash: createHash("sha256").update(text).digest("hex"),
  };
}
