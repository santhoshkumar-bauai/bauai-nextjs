import type { ObjectId } from "mongodb";

import type { CompanyContext } from "../../company/context.ts";
import type { SerializedTenderDetail } from "../../tenders/detail.ts";
import {
  normalizeRecommendation,
  RECOMMENDATION_SCHEMA,
  type TenderRecommendation,
} from "../../tenders/recommendation.ts";
import { z } from "zod";

import { getAiCollections } from "../db/collections.ts";
import { getGateway } from "../gateway/index.ts";
import { resolveRole } from "../gateway/config.ts";
import { hybridRetrieveCompanyChunks } from "../retrieval/hybrid.ts";
import { forCompanyContext, TenantRepository } from "../tenant/repository.ts";
import type { TenderFitRecommendationDocument } from "../types.ts";
import { buildFullCompanyContext, type CompanyContextInput } from "./company-context.ts";
import { hashCompanyData, listEmbeddedCompanyDocs } from "./company-hash.ts";
import { buildFitPrompt, FIT_PROMPT_VERSION } from "./prompt.ts";

const EVIDENCE_K = 8;

/** Plain profile snapshot from the Mongoose company document. */
export function companyProfileInput(
  company: CompanyContext["company"],
): CompanyContextInput {
  return {
    name: company.name,
    businessDomain: company.businessDomain,
    region: company.region,
    address: company.address,
    employeeCount: company.employeeCount ?? null,
    services: company.services,
    cpvCodes: company.cpvCodes,
    trade: company.trade,
    specializations: company.specializations,
    certifications: company.certifications,
    projectSizeRange: company.projectSizeRange ?? null,
    insurances: company.insurances,
    referenceProjects: company.referenceProjects,
    knowledgeBase: company.knowledgeBase
      ? (JSON.parse(JSON.stringify(company.knowledgeBase)) as CompanyContextInput["knowledgeBase"])
      : null,
  };
}

async function fitRepository(context: CompanyContext) {
  const { tenderFitRecommendations } = await getAiCollections();
  return new TenantRepository<TenderFitRecommendationDocument>(
    tenderFitRecommendations,
    forCompanyContext(context),
  );
}

export interface FitState {
  recommendation: TenderRecommendation | null;
  stale: boolean;
  generatedAt: Date | null;
}

export async function getFitState(
  context: CompanyContext,
  tenderId: ObjectId,
): Promise<FitState> {
  const repo = await fitRepository(context);
  const record = await repo.findOne({ tenderId } as never);
  if (!record) return { recommendation: null, stale: false, generatedAt: null };

  const profile = companyProfileInput(context.company);
  const embeddedDocs = await listEmbeddedCompanyDocs(repo.tenantId);
  const currentHash = hashCompanyData(profile, embeddedDocs);

  return {
    recommendation: record.recommendation as unknown as TenderRecommendation,
    stale:
      record.companyDataHash !== currentHash ||
      record.model.promptVersion !== FIT_PROMPT_VERSION,
    generatedAt: record.updatedAt,
  };
}

export async function generateFit(input: {
  context: CompanyContext;
  tenderId: ObjectId;
  tender: SerializedTenderDetail;
  locale: "en" | "de";
}): Promise<TenderRecommendation> {
  const repo = await fitRepository(input.context);
  const tenantId = repo.tenantId;

  const profile = companyProfileInput(input.context.company);
  const companyContext = buildFullCompanyContext(profile);
  const embeddedDocs = await listEmbeddedCompanyDocs(tenantId);
  const companyDataHash = hashCompanyData(profile, embeddedDocs);

  // Company evidence: retrieve the tenant's own document chunks against the
  // tender's subject. Skipped when the tenant has no embedded documents.
  const evidence =
    embeddedDocs.length > 0
      ? await hybridRetrieveCompanyChunks({
          text: [
            input.tender.title ?? "",
            input.tender.cpvCodes.join(" "),
            (input.tender.description ?? "").slice(0, 500),
          ]
            .filter(Boolean)
            .join("\n"),
          filters: { tenantId },
          k: EVIDENCE_K,
        })
      : [];

  const { extractions } = await getAiCollections();
  const extractionRecords = await extractions
    .find({
      tenderId: input.tenderId,
      schemaName: { $in: ["deadlines", "suitability_criteria", "contractual_penalties"] },
    })
    .toArray();

  const prompt = buildFitPrompt({
    companyContext,
    tender: input.tender,
    evidence,
    extractions: extractionRecords,
    locale: input.locale,
  });

  const result = await getGateway().generateStructured({
    role: "reasoning",
    prompt,
    schema: RECOMMENDATION_SCHEMA as unknown as Record<string, unknown>,
    zod: z.record(z.string(), z.unknown()),
  });

  const recommendation = normalizeRecommendation(result.value);
  if (!recommendation) {
    throw new Error("Model returned an incomplete recommendation");
  }

  const modelRef = resolveRole("reasoning");
  const record = {
    tenderId: input.tenderId,
    companyDataHash,
    locale: input.locale,
    recommendation: recommendation as unknown as Record<string, unknown>,
    model: {
      provider: modelRef.provider,
      providerModel: modelRef.model,
      promptVersion: FIT_PROMPT_VERSION,
    },
    corpusHash:
      extractionRecords.length > 0 ? extractionRecords[0].corpusHash : null,
    retrievedChunkIds: evidence.map((chunk) => String(chunk.chunkId)),
  };

  const updated = await repo.updateOne({ tenderId: input.tenderId } as never, {
    $set: record as never,
  });
  if (updated.matchedCount === 0) {
    await repo.insertOne(record as never);
  }

  return recommendation;
}
