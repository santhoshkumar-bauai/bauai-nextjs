import type {
  CompanyDocument,
  CompanyKnowledgeBase,
} from "@/models/company";
import type { CompanyFileDocument, CompanyFileCategory } from "@/models/company-file";

/** Common timestamp/_id fields Mongoose adds; typed loosely so hydrated docs and lean objects both fit. */
type WithMeta<T> = T & {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

export type SerializedCompanyFile = {
  id: string;
  category: CompanyFileCategory;
  fileName: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  createdAt: string | null;
};

/** Shapes a company file document for the client. The S3 key is never exposed. */
export function serializeCompanyFile(
  file: WithMeta<CompanyFileDocument>,
): SerializedCompanyFile {
  return {
    id: String(file._id),
    category: file.category,
    fileName: file.fileName,
    contentType: file.contentType,
    size: file.size,
    uploadedBy: file.uploadedBy,
    createdAt: file.createdAt ? file.createdAt.toISOString() : null,
  };
}

/**
 * Shapes the company-details profile for the client. Membership internals
 * (members, requests, trial, createdBy) are omitted — those have their own
 * endpoints — and the raw logo S3 key is replaced by a resolved URL upstream.
 */
/** Client-facing shape of the company profile (import as a type only). */
export type SerializedCompanyProfile = ReturnType<typeof serializeCompanyProfile>;

/**
 * Deep-converts a (possibly Mongoose) value to a plain, RSC-serializable clone.
 * Hydrated documents hand back subdocuments/arrays that carry `toJSON`, which
 * React refuses to pass to client components — the round-trip strips them.
 */
function plain<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export function serializeCompanyProfile(
  company: WithMeta<CompanyDocument>,
  extras: { logoUrl?: string | null } = {},
) {
  return {
    id: String(company._id),
    name: company.name,
    domain: company.domain,
    website: company.website ?? null,
    businessDomain: company.businessDomain ?? null,
    region: company.region ?? null,
    companyDomain: company.companyDomain ?? null,
    companyDomainOther: company.companyDomainOther ?? null,
    email: company.email ?? null,
    phone: company.phone ?? null,
    logoUrl: extras.logoUrl ?? null,
    hasLogo: Boolean(company.logoKey),
    vatNumber: company.vatNumber ?? null,
    registrationNumber: company.registrationNumber ?? null,
    address: company.address ?? null,
    addressCoordinates: plain(company.addressCoordinates) ?? null,
    services: plain(company.services) ?? [],
    cpvCodes: plain(company.cpvCodes) ?? [],
    trade: plain(company.trade) ?? [],
    specializations: plain(company.specializations) ?? [],
    certifications: plain(company.certifications) ?? [],
    projectSizeRange: plain(company.projectSizeRange) ?? null,
    employeeCount: company.employeeCount ?? null,
    bankDetails: plain(company.bankDetails) ?? null,
    insurances: plain(company.insurances) ?? [],
    referenceProjects: plain(company.referenceProjects) ?? [],
    knowledgeBase: (plain(company.knowledgeBase) ?? {}) as CompanyKnowledgeBase,
    createdAt: company.createdAt ? company.createdAt.toISOString() : null,
    updatedAt: company.updatedAt ? company.updatedAt.toISOString() : null,
  };
}
