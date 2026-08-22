import { ObjectId } from "mongodb";

import { getAiCollections } from "@/lib/ai/db/collections";
import { Company } from "@/models/company";

import type { DocumentFillEvidence } from "./types";

/**
 * Evidence gathering for a fill run. Nothing here depends on the document
 * format — a PDF and a DOCX ground against the same company profile and the
 * same chunk corpus — so both analyzers share it.
 *
 * The evidence Map is the trust boundary: the model may only cite keys that
 * are in it, and the resolvers silently drop references that are not, which is
 * what makes `evidence.length === 0` a meaningful demotion signal rather than
 * a formality.
 */

/** Keys that are plumbing, not company facts. */
const PROFILE_SKIP = [
  "_id",
  "members",
  "membershipRequests",
  "trial",
  "createdBy",
  "createdAt",
  "updatedAt",
];

/** Company doc -> dotted scalar keys (`company.address.city`), blanks dropped. */
export function flattenCompanyProfile(
  value: unknown,
  prefix = "company",
  out = new Map<string, string>(),
) {
  if (value == null) return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenCompanyProfile(item, `${prefix}.${index}`, out));
  } else if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (!PROFILE_SKIP.includes(key)) {
        flattenCompanyProfile(item, `${prefix}.${key}`, out);
      }
    }
  } else if (String(value).trim()) {
    out.set(prefix, String(value).trim());
  }
  return out;
}

export interface FillGrounding {
  evidence: Map<string, DocumentFillEvidence>;
  profileLines: string[];
  corpusLines: string[];
}

/**
 * Structured profile values plus a bounded slice of the chunk corpus, both
 * registered as citable evidence.
 *
 * The corpus slice is a flat `chunkIndex` sort capped at 40 — deliberately not
 * semantic retrieval, because discovery has no single query to retrieve
 * against; it is looking at every field at once.
 */
export async function buildFillGrounding(input: {
  tenantId: ObjectId;
  tenderId: ObjectId | null;
}): Promise<FillGrounding> {
  const { chunks } = await getAiCollections();
  const company = await Company.findById(input.tenantId).lean();
  if (!company) throw new Error("document_context_missing");

  const evidence = new Map<string, DocumentFillEvidence>();
  const profileLines = [...flattenCompanyProfile(company).entries()].map(([key, value]) => {
    evidence.set(key, {
      source: "company_profile",
      reference: key,
      excerpt: value.slice(0, 240),
    });
    return `${key}: ${value}`;
  });

  const corpus = await chunks
    .find({
      $or: [
        { tenantId: input.tenantId },
        ...(input.tenderId ? [{ tenantId: null, tenderId: input.tenderId }] : []),
      ],
    })
    .sort({ chunkIndex: 1 })
    .limit(40)
    .toArray();
  const corpusLines = corpus.map((chunk) => {
    const ref = `chunk:${chunk._id?.toHexString() ?? `${chunk.documentRecordId}:${chunk.chunkIndex}`}`;
    evidence.set(ref, {
      source: chunk.tenantId ? "company_document" : "tender",
      reference: ref,
      excerpt: chunk.text.slice(0, 240),
    });
    return `${ref} (${chunk.fileName}, ${chunk.sectionPath.join(" > ")}): ${chunk.text}`;
  });

  return { evidence, profileLines, corpusLines };
}
