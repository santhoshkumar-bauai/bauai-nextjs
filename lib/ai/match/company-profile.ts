import { createHash } from "node:crypto";

import { ObjectId } from "mongodb";

import { getIngestionDb } from "../../ingestion/db/client.ts";
import { logger } from "../../ingestion/observability/logger.ts";
import { resolveCompanyNuts } from "../../tenders/nuts.ts";
import { stripCheckDigit } from "../../tenders/relevance.ts";
import { getCompanyFilesCollection } from "../company/doc-embedder.ts";
import { aiEnv } from "../config/env.ts";
import { getAiCollections } from "../db/collections.ts";
import { hashCompanyData, listEmbeddedCompanyDocs } from "../fit/company-hash.ts";
import type { CompanyContextInput } from "../fit/company-context.ts";
import { getGateway } from "../gateway/index.ts";
import type { CompanyMatchProfileDocument } from "../types.ts";
import { resolveCpvNames } from "./cpv.ts";
import {
  buildCompanyFacets,
  MATCH_PROFILE_VERSION,
  type DocumentFacetInput,
} from "./facets.ts";

/**
 * Builds and persists the company's match profile: the facet texts from
 * `facets.ts`, embedded as query vectors and stored in `company_match_profiles`.
 *
 * Everything here uses the native driver rather than Mongoose — this runs
 * inside the BullMQ worker, where Mongoose's CJS named exports do not survive
 * Node's strip-types ESM loader (same constraint as
 * `lib/ai/company/doc-embedder.ts`).
 */

const log = logger.child("ai.match.profile");

/** Chunk text budget per document facet. */
const DOC_FACET_CHARS = 4000;
/** Documents considered for a facet, newest chunks first. */
const MAX_DOCUMENT_FACETS = 12;

/** Native-driver view of the Mongoose `Company` model. */
interface CompanyRow extends CompanyContextInput {
  _id: ObjectId;
  regionLocation?: { latitude?: number; longitude?: number } | null;
  addressCoordinates?: { lat?: number; lng?: number } | null;
}

export function embeddingIdentity(): string {
  const env = aiEnv();
  return `${env.embeddingModel}:${env.embeddingVersion}:${env.embeddingDimensions}`;
}

export async function getCompaniesCollection() {
  const db = await getIngestionDb();
  return db.collection<CompanyRow>("companies");
}

/**
 * Categories whose documents must never become retrieval facets. What a file
 * *is* decides what its text is evidence of: an insurance certificate proves
 * eligibility, but embedded as a query it retrieves insurance-services
 * tenders (measured — Wirl Ing's HDI certificate pulled in
 * Versicherungsdienstleistungen notices). Logos have no text worth querying.
 * Insurance stays represented through the structured `insurances` fields in
 * the qualifications facet, where it belongs.
 */
const EXCLUDED_FACET_CATEGORIES = new Set(["logo", "insurance"]);

/** `documentRecordId` is `company:{fileId}` — recover the file id. */
function fileIdFromRecordId(documentRecordId: string): string | null {
  return documentRecordId.startsWith("company:")
    ? documentRecordId.slice("company:".length)
    : null;
}

/**
 * Embedded-doc identities with the user-picked category folded into the sha
 * field. `hashCompanyData` only string-joins the pair, so this makes a
 * category edit change the company-data hash — without it, re-categorizing a
 * file (say insurance → reference-project) would silently keep the old
 * facets forever, because neither the profile fields nor the file bytes
 * changed.
 */
async function listEmbeddedDocsWithCategory(
  tenantId: ObjectId,
): Promise<Array<{ documentRecordId: string; fileSha256: string }>> {
  const docs = await listEmbeddedCompanyDocs(tenantId);
  const fileIds = docs
    .map((doc) => fileIdFromRecordId(doc.documentRecordId))
    .filter((id): id is string => id != null && ObjectId.isValid(id));
  const companyFiles = await getCompanyFilesCollection();
  const categories = new Map<string, string>(
    (
      await companyFiles
        .find({ _id: { $in: fileIds.map((id) => new ObjectId(id)) } })
        .project<{ _id: ObjectId; category: string }>({ category: 1 })
        .toArray()
    ).map((file) => [file._id.toHexString(), file.category]),
  );
  return docs.map((doc) => {
    const fileId = fileIdFromRecordId(doc.documentRecordId);
    const category = (fileId && categories.get(fileId)) || "general";
    return { ...doc, fileSha256: `${doc.fileSha256}:${category}` };
  });
}

/**
 * The company's own documents, one text per document, assembled from the
 * chunks that were already extracted and embedded for the fit analysis. No S3
 * read and no re-chunking — the text is right there.
 *
 * Joined against `companyfiles` for the user-picked category: it is the one
 * piece of intent we have about what each upload IS, and it decides whether
 * the document becomes a retrieval facet at all and at what weight.
 */
async function loadDocumentTexts(tenantId: ObjectId): Promise<DocumentFacetInput[]> {
  const { chunks } = await getAiCollections();
  const rows = await chunks
    .find({ tenantId, tenderId: null })
    .project<{
      documentRecordId: string;
      fileName: string;
      text: string;
      chunkIndex: number;
    }>({ documentRecordId: 1, fileName: 1, text: 1, chunkIndex: 1 })
    .sort({ documentRecordId: 1, chunkIndex: 1 })
    .toArray();

  const byDocument = new Map<string, { fileName: string | null; parts: string[] }>();
  for (const row of rows) {
    const entry = byDocument.get(row.documentRecordId) ?? {
      fileName: row.fileName ?? null,
      parts: [],
    };
    entry.parts.push(row.text);
    byDocument.set(row.documentRecordId, entry);
  }

  const fileIds = [...byDocument.keys()]
    .map(fileIdFromRecordId)
    .filter((id): id is string => id != null && ObjectId.isValid(id));
  const companyFiles = await getCompanyFilesCollection();
  const categories = new Map<string, string>(
    (
      await companyFiles
        .find({ _id: { $in: fileIds.map((id) => new ObjectId(id)) } })
        .project<{ _id: ObjectId; category: string }>({ category: 1 })
        .toArray()
    ).map((file) => [file._id.toHexString(), file.category]),
  );

  return [...byDocument.entries()]
    .map(([documentRecordId, entry]) => {
      const fileId = fileIdFromRecordId(documentRecordId);
      // A missing file row means the upload was deleted but its chunks
      // linger; "general" keeps it usable without granting it extra weight.
      const category = (fileId && categories.get(fileId)) || "general";
      return { documentRecordId, entry, category };
    })
    .filter(({ category }) => !EXCLUDED_FACET_CATEGORIES.has(category))
    .slice(0, MAX_DOCUMENT_FACETS)
    .map(({ documentRecordId, entry, category }) => ({
      documentRecordId,
      fileName: entry.fileName,
      category,
      // Leading chunks, in document order: the front of a reference-project
      // PDF or a capability statement is where the scope is described.
      text: entry.parts.join("\n\n").slice(0, DOC_FACET_CHARS),
    }));
}

export interface MatchProfileState {
  profile: CompanyMatchProfileDocument | null;
  companyDataHash: string;
  stale: boolean;
}

/**
 * The current stored profile plus whether it still reflects reality.
 *
 * Staleness is the same triple used everywhere else in the AI subsystem:
 * company data, pipeline version, and the embedding identity. The last one is
 * not optional — querying a `vx_tender_search_documents` index built with one
 * model using vectors from another produces confident nonsense, so a profile
 * whose identity has drifted is never queried with.
 */
export async function getMatchProfileState(
  tenantId: ObjectId,
): Promise<MatchProfileState> {
  const { companyMatchProfiles } = await getAiCollections();

  const companies = await getCompaniesCollection();
  const company = await companies.findOne({ _id: tenantId });
  if (!company) throw new Error(`company ${tenantId.toHexString()} not found`);

  const embeddedDocs = await listEmbeddedDocsWithCategory(tenantId);
  const companyDataHash = hashCompanyData(toCompanyContext(company), embeddedDocs);

  const profile = await companyMatchProfiles.findOne({ tenantId });
  const stale =
    !profile ||
    profile.companyDataHash !== companyDataHash ||
    profile.profileVersion !== profileVersion() ||
    `${profile.embeddingModel}:${profile.embeddingVersion}:${profile.embeddingDimensions}` !==
      embeddingIdentity();

  return { profile: profile ?? null, companyDataHash, stale };
}

function profileVersion(): string {
  // The env override exists so an experiment can invalidate every profile
  // without a code change; the const is the real default.
  return `${MATCH_PROFILE_VERSION}:${aiEnv().matchProfileVersion}`;
}

/** Narrow a native company row to the shape the fit/context helpers expect. */
export function toCompanyContext(company: CompanyRow): CompanyContextInput {
  return {
    name: company.name,
    businessDomain: company.businessDomain,
    region: company.region,
    address: company.address,
    employeeCount: company.employeeCount,
    services: company.services,
    cpvCodes: company.cpvCodes,
    trade: company.trade,
    specializations: company.specializations,
    certifications: company.certifications,
    projectSizeRange: company.projectSizeRange,
    insurances: company.insurances,
    referenceProjects: company.referenceProjects,
    knowledgeBase: company.knowledgeBase,
  };
}

/**
 * Rebuild the company's facet vectors and store them. Idempotent: callers that
 * already know the profile is fresh should not call this at all.
 */
export async function buildMatchProfile(
  tenantId: ObjectId,
): Promise<CompanyMatchProfileDocument> {
  const env = aiEnv();
  const { companyMatchProfiles } = await getAiCollections();

  const companies = await getCompaniesCollection();
  const company = await companies.findOne({ _id: tenantId });
  if (!company) throw new Error(`company ${tenantId.toHexString()} not found`);

  const context = toCompanyContext(company);
  const [cpvNames, documents, embeddedDocs] = await Promise.all([
    resolveCpvNames(company.cpvCodes ?? []),
    loadDocumentTexts(tenantId),
    listEmbeddedDocsWithCategory(tenantId),
  ]);

  const { facets, skipped } = buildCompanyFacets({
    company: context,
    cpvNames,
    documents,
    maxFacets: env.matchMaxFacets,
  });

  // RETRIEVAL_QUERY, not RETRIEVAL_DOCUMENT: these vectors are the query side
  // of an asymmetric retrieval against tender notices that were embedded as
  // documents. Using the wrong task type quietly degrades every result.
  const embedded =
    facets.length > 0
      ? await getGateway().embed({
          texts: facets.map((facet) => facet.text),
          taskType: "RETRIEVAL_QUERY",
        })
      : null;

  const now = new Date();
  const nuts = resolveCompanyNuts({
    region: company.region ?? null,
    regionLocation: company.regionLocation ?? null,
    addressCoordinates: company.addressCoordinates ?? null,
  });

  const doc: CompanyMatchProfileDocument = {
    tenantId,
    companyDataHash: hashCompanyData(context, embeddedDocs),
    profileVersion: profileVersion(),
    embeddingModel: embedded?.model ?? env.embeddingModel,
    embeddingVersion: embedded?.version ?? env.embeddingVersion,
    embeddingDimensions: embedded?.dimensions ?? env.embeddingDimensions,
    facets: facets.map((facet, index) => ({
      key: facet.key,
      kind: facet.kind,
      label: facet.label,
      weight: facet.weight,
      text: facet.text,
      sourceHash: createHash("sha256").update(facet.text).digest("hex"),
      embedding: embedded?.vectors[index] ?? [],
    })),
    scope: {
      countries: [nuts.country],
      nuts: {
        country: nuts.country,
        nuts1: nuts.nuts1,
        nuts2: nuts.nuts2,
        nuts3: nuts.nuts3,
      },
      cpvCodes: [
        ...new Set((company.cpvCodes ?? []).map(stripCheckDigit).filter(Boolean)),
      ],
    },
    skipped,
    builtAt: now,
    createdAt: now,
    updatedAt: now,
  };

  // `createdAt` belongs to $setOnInsert only — $set would reset it on rebuild.
  const mutable: Partial<CompanyMatchProfileDocument> = { ...doc };
  delete mutable.createdAt;
  await companyMatchProfiles.updateOne(
    { tenantId },
    { $set: mutable, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );

  log.info("built match profile", {
    tenantId: tenantId.toHexString(),
    facets: doc.facets.length,
    documentFacets: doc.facets.filter((f) => f.kind === "document").length,
    skipped: skipped.length,
  });

  return doc;
}

/** Coverage summary for the "improve your matching" nudge. */
export function profileCoverage(profile: CompanyMatchProfileDocument | null) {
  if (!profile) {
    return { facets: 0, profileFacets: 0, documentFacets: 0, skipped: [] as const };
  }
  return {
    facets: profile.facets.length,
    profileFacets: profile.facets.filter((f) => f.kind === "profile").length,
    documentFacets: profile.facets.filter((f) => f.kind === "document").length,
    skipped: profile.skipped,
  };
}
