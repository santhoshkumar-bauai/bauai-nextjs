import { Schema, model, models, type Model } from "mongoose";

export type CompanyMemberRole = "admin" | "member";
export type MembershipRequestStatus = "pending" | "approved" | "rejected";

/**
 * Bank account details. Replicated from the mvp1 `companies.bank_details` JSON
 * column, now a typed sub-document.
 */
export interface BankDetails {
  bankName?: string;
  accountNumber?: string;
  accountHolder?: string;
  iban?: string;
  bic?: string;
}

/** A single insurance policy entry (mvp1 `companies.insurances`). */
export interface InsuranceInfo {
  type: string;
  amount: string;
  details?: string;
}

/** A single reference project entry (mvp1 `companies.reference_projects`). */
export interface ReferenceProject {
  title: string;
  description: string;
  client?: string;
  year?: string;
  value?: string;
}

/**
 * Knowledge base — the structured profile mvp1 stored in the
 * `companies.knowledge_base` JSON column. Every field is optional; the user
 * fills it in progressively and the document filler reads whatever is present.
 */
export interface CompanyKnowledgeBase {
  companyExtended?: {
    legalForm?: string;
    foundingYear?: string;
    description?: string;
    registrationCourt?: string;
  };
  principalOffice?: {
    streetAddress?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    county?: string;
    country?: string;
  };
  mailingAddress?: {
    address?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  };
  contactInfo?: {
    mainPhone?: string;
    mobile?: string;
    fax?: string;
    email?: string;
    website?: string;
  };
  primaryContact?: CompanyContactPerson;
  authorizedSigner?: CompanyContactPerson;
  financialInfo?: {
    revenueCurrent?: string;
    revenueYear1?: string;
    revenueYear2?: string;
    revenueYear3?: string;
  };
  bankExtended?: {
    bankAddress?: string;
    bankCity?: string;
    bankState?: string;
    contactName?: string;
    bankPhone?: string;
  };
  insuranceDetails?: {
    glCarrier?: string;
    glPolicyNumber?: string;
    glCoverageLimit?: string;
    glExpiration?: string;
    wcCarrier?: string;
    wcPolicyNumber?: string;
    wcExpiration?: string;
    emr?: string;
    emrEffectiveDate?: string;
  };
  bonding?: {
    suretyCompany?: string;
    agentName?: string;
    agentCompany?: string;
    agentPhone?: string;
    agentEmail?: string;
    bondingCapacity?: string;
    singleProjectLimit?: string;
  };
  businessCertifications?: {
    sbe?: boolean;
    lbe?: boolean;
    dbe?: boolean;
    mbe?: boolean;
    wbe?: boolean;
    wosb?: boolean;
    hubzone?: boolean;
    sdvosb?: boolean;
    vosb?: boolean;
    eightA?: boolean;
    otherCertifications?: string;
  };
  technicalNarratives?: {
    safetyApproach?: string;
    qualityControlProcess?: string;
    capabilitiesStatement?: string;
    pastPerformanceSummary?: string;
  };
}

export interface CompanyContactPerson {
  name?: string;
  firstName?: string;
  lastName?: string;
  title?: string;
  role?: string;
  email?: string;
  phone?: string;
}

export interface CompanyDocument {
  name: string;
  domain: string;
  website: string;
  businessDomain: string;
  region: string;
  regionLocation?: {
    placeId: string;
    latitude: number;
    longitude: number;
  };
  services: string[];
  cpvCodes: string[];
  // --- Replicated company-details profile (mvp1 `companies` row) ---
  companyDomain?: string;
  companyDomainOther?: string;
  email?: string;
  phone?: string;
  logoKey?: string;
  vatNumber?: string;
  registrationNumber?: string;
  address?: string;
  addressCoordinates?: {
    lat: number;
    lng: number;
  };
  trade: string[];
  specializations: string[];
  certifications: string[];
  projectSizeRange?: {
    min?: string;
    max?: string;
  };
  employeeCount?: number;
  bankDetails?: BankDetails;
  insurances: InsuranceInfo[];
  referenceProjects: ReferenceProject[];
  knowledgeBase?: CompanyKnowledgeBase;
  // --- Membership / lifecycle ---
  members: Array<{
    userId: string;
    email: string;
    role: CompanyMemberRole;
    joinedAt: Date;
  }>;
  membershipRequests: Array<{
    userId: string;
    email: string;
    status: MembershipRequestStatus;
    requestedAt: Date;
    reviewedAt?: Date;
    reviewedBy?: string;
  }>;
  trial: {
    status: "active" | "expired";
    startsAt: Date;
    endsAt: Date;
  };
  createdBy: string;
}

const contactPersonSchema = new Schema<CompanyContactPerson>(
  {
    name: { type: String, trim: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    title: { type: String, trim: true },
    role: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
  },
  { _id: false },
);

const knowledgeBaseSchema = new Schema<CompanyKnowledgeBase>(
  {
    companyExtended: {
      type: new Schema(
        {
          legalForm: { type: String, trim: true },
          foundingYear: { type: String, trim: true },
          description: { type: String, trim: true },
          registrationCourt: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    principalOffice: {
      type: new Schema(
        {
          streetAddress: { type: String, trim: true },
          city: { type: String, trim: true },
          state: { type: String, trim: true },
          zipCode: { type: String, trim: true },
          county: { type: String, trim: true },
          country: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    mailingAddress: {
      type: new Schema(
        {
          address: { type: String, trim: true },
          city: { type: String, trim: true },
          state: { type: String, trim: true },
          zipCode: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    contactInfo: {
      type: new Schema(
        {
          mainPhone: { type: String, trim: true },
          mobile: { type: String, trim: true },
          fax: { type: String, trim: true },
          email: { type: String, trim: true, lowercase: true },
          website: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    primaryContact: { type: contactPersonSchema },
    authorizedSigner: { type: contactPersonSchema },
    financialInfo: {
      type: new Schema(
        {
          revenueCurrent: { type: String, trim: true },
          revenueYear1: { type: String, trim: true },
          revenueYear2: { type: String, trim: true },
          revenueYear3: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    bankExtended: {
      type: new Schema(
        {
          bankAddress: { type: String, trim: true },
          bankCity: { type: String, trim: true },
          bankState: { type: String, trim: true },
          contactName: { type: String, trim: true },
          bankPhone: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    insuranceDetails: {
      type: new Schema(
        {
          glCarrier: { type: String, trim: true },
          glPolicyNumber: { type: String, trim: true },
          glCoverageLimit: { type: String, trim: true },
          glExpiration: { type: String, trim: true },
          wcCarrier: { type: String, trim: true },
          wcPolicyNumber: { type: String, trim: true },
          wcExpiration: { type: String, trim: true },
          emr: { type: String, trim: true },
          emrEffectiveDate: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    bonding: {
      type: new Schema(
        {
          suretyCompany: { type: String, trim: true },
          agentName: { type: String, trim: true },
          agentCompany: { type: String, trim: true },
          agentPhone: { type: String, trim: true },
          agentEmail: { type: String, trim: true, lowercase: true },
          bondingCapacity: { type: String, trim: true },
          singleProjectLimit: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    businessCertifications: {
      type: new Schema(
        {
          sbe: { type: Boolean },
          lbe: { type: Boolean },
          dbe: { type: Boolean },
          mbe: { type: Boolean },
          wbe: { type: Boolean },
          wosb: { type: Boolean },
          hubzone: { type: Boolean },
          sdvosb: { type: Boolean },
          vosb: { type: Boolean },
          eightA: { type: Boolean },
          otherCertifications: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    technicalNarratives: {
      type: new Schema(
        {
          safetyApproach: { type: String, trim: true },
          qualityControlProcess: { type: String, trim: true },
          capabilitiesStatement: { type: String, trim: true },
          pastPerformanceSummary: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
  },
  { _id: false, minimize: false },
);

const companySchema = new Schema<CompanyDocument>(
  {
    name: { type: String, required: true, trim: true },
    domain: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },
    website: { type: String, required: true },
    businessDomain: { type: String, required: true },
    region: { type: String, required: true },
    regionLocation: {
      placeId: { type: String },
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
    },
    services: { type: [String], default: [] },
    cpvCodes: { type: [String], default: [] },
    companyDomain: { type: String, trim: true },
    companyDomainOther: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
    logoKey: { type: String, trim: true },
    vatNumber: { type: String, trim: true },
    registrationNumber: { type: String, trim: true },
    address: { type: String, trim: true },
    addressCoordinates: {
      lat: { type: Number, min: -90, max: 90 },
      lng: { type: Number, min: -180, max: 180 },
    },
    trade: { type: [String], default: [] },
    specializations: { type: [String], default: [] },
    certifications: { type: [String], default: [] },
    projectSizeRange: {
      min: { type: String, trim: true },
      max: { type: String, trim: true },
    },
    employeeCount: { type: Number, min: 0 },
    bankDetails: {
      type: new Schema<BankDetails>(
        {
          bankName: { type: String, trim: true },
          accountNumber: { type: String, trim: true },
          accountHolder: { type: String, trim: true },
          iban: { type: String, trim: true },
          bic: { type: String, trim: true },
        },
        { _id: false },
      ),
    },
    insurances: {
      type: [
        new Schema<InsuranceInfo>(
          {
            type: { type: String, required: true, trim: true },
            amount: { type: String, required: true, trim: true },
            details: { type: String, trim: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    referenceProjects: {
      type: [
        new Schema<ReferenceProject>(
          {
            title: { type: String, required: true, trim: true },
            description: { type: String, required: true, trim: true },
            client: { type: String, trim: true },
            year: { type: String, trim: true },
            value: { type: String, trim: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    knowledgeBase: { type: knowledgeBaseSchema },
    members: {
      type: [
        {
          userId: { type: String, required: true },
          email: { type: String, required: true, lowercase: true },
          role: { type: String, enum: ["admin", "member"], required: true },
          joinedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    membershipRequests: {
      type: [
        {
          userId: { type: String, required: true },
          email: { type: String, required: true, lowercase: true },
          status: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
          },
          requestedAt: { type: Date, default: Date.now },
          reviewedAt: { type: Date },
          reviewedBy: { type: String },
        },
      ],
      default: [],
    },
    trial: {
      status: { type: String, enum: ["active", "expired"], default: "active" },
      startsAt: { type: Date, required: true },
      endsAt: { type: Date, required: true },
    },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

companySchema.index({ "membershipRequests.userId": 1 });

export const Company =
  (models.Company as Model<CompanyDocument>) ||
  model<CompanyDocument>("Company", companySchema);
