/**
 * Field configuration for the company-settings section forms. Plain data (no
 * React / no server imports) so both client form components and the section
 * pages can share it. Each section maps to a slice of the company profile:
 *
 * - `root`            -> top-level Company fields
 * - `bankDetails`     -> Company.bankDetails
 * - `projectSizeRange`-> Company.projectSizeRange
 * - a knowledgeBase key -> Company.knowledgeBase[key]
 */

export type FieldType = "text" | "email" | "number" | "date" | "textarea" | "tags";

export type FieldDef = {
  key: string;
  label: string;
  type?: FieldType;
  placeholder?: string;
};

export type SectionGroup =
  | "root"
  | "bankDetails"
  | "projectSizeRange"
  | "companyExtended"
  | "principalOffice"
  | "mailingAddress"
  | "primaryContact"
  | "financialInfo"
  | "insuranceDetails";

export type SectionConfig = {
  title: string;
  description: string;
  group: SectionGroup;
  fields: FieldDef[];
};

export const COMPANY_INFO_SECTION: SectionConfig = {
  title: "Company information",
  description: "The core details other companies and tenders see first.",
  group: "root",
  fields: [
    { key: "name", label: "Company name", placeholder: "BAU AI" },
    { key: "email", label: "Company email", type: "email", placeholder: "info@bauai.eu" },
    { key: "website", label: "Website", placeholder: "bauai.eu" },
    { key: "phone", label: "Phone", placeholder: "+49 89 123456" },
    { key: "employeeCount", label: "Number of employees", type: "number", placeholder: "50" },
    { key: "registrationNumber", label: "Registration number", placeholder: "1234567890" },
    { key: "vatNumber", label: "VAT number", placeholder: "DE123456789" },
    { key: "address", label: "Address", placeholder: "Leopoldstrasse 1, Munich" },
  ],
};

export const COMPANY_DETAILS_SECTION: SectionConfig = {
  title: "Company details",
  description: "Legal form, founding year, and company description.",
  group: "companyExtended",
  fields: [
    { key: "legalForm", label: "Legal form", placeholder: "GmbH" },
    { key: "foundingYear", label: "Founding year", placeholder: "2008" },
    { key: "registrationCourt", label: "Registration court", placeholder: "Amtsgericht München" },
    { key: "description", label: "Company description", type: "textarea", placeholder: "Brief company description..." },
  ],
};

export const PRINCIPAL_OFFICE_SECTION: SectionConfig = {
  title: "Principal office",
  description: "The company's primary registered address.",
  group: "principalOffice",
  fields: [
    { key: "streetAddress", label: "Street address", placeholder: "123 Main St" },
    { key: "city", label: "City", placeholder: "Munich" },
    { key: "state", label: "State", placeholder: "Bavaria" },
    { key: "zipCode", label: "ZIP code", placeholder: "80331" },
    { key: "county", label: "County", placeholder: "Munich" },
    { key: "country", label: "Country", placeholder: "Germany" },
  ],
};

export const MAILING_ADDRESS_SECTION: SectionConfig = {
  title: "Mailing address",
  description: "Where post should be sent, if different from the office.",
  group: "mailingAddress",
  fields: [
    { key: "address", label: "Address", placeholder: "P.O. Box 123" },
    { key: "city", label: "City", placeholder: "Munich" },
    { key: "state", label: "State", placeholder: "Bavaria" },
    { key: "zipCode", label: "ZIP code", placeholder: "80331" },
  ],
};

export const PRIMARY_CONTACT_SECTION: SectionConfig = {
  title: "Primary contact",
  description: "The main point of contact for tenders and correspondence.",
  group: "primaryContact",
  fields: [
    { key: "firstName", label: "First name", placeholder: "Jane" },
    { key: "lastName", label: "Last name", placeholder: "Doe" },
    { key: "title", label: "Title", placeholder: "Project Manager" },
    { key: "role", label: "Role", placeholder: "Lead Engineer" },
    { key: "email", label: "Email", type: "email", placeholder: "jane@company.com" },
    { key: "phone", label: "Phone", placeholder: "+49 89 123456" },
  ],
};

export const FINANCIAL_INFO_SECTION: SectionConfig = {
  title: "Financial information",
  description: "Recent annual revenue figures.",
  group: "financialInfo",
  fields: [
    { key: "revenueCurrent", label: "Current revenue", placeholder: "€5,000,000" },
    { key: "revenueYear1", label: "Revenue (last year)", placeholder: "€4,500,000" },
    { key: "revenueYear2", label: "Revenue (2 years ago)", placeholder: "€4,000,000" },
    { key: "revenueYear3", label: "Revenue (3 years ago)", placeholder: "€3,500,000" },
  ],
};

export const BANK_DETAILS_SECTION: SectionConfig = {
  title: "Bank details",
  description: "Account information used on tender submissions.",
  group: "bankDetails",
  fields: [
    { key: "bankName", label: "Bank name", placeholder: "Deutsche Bank" },
    { key: "accountHolder", label: "Account holder", placeholder: "BAU AI GmbH" },
    { key: "iban", label: "IBAN", placeholder: "DE00 0000 0000 0000 0000 00" },
    { key: "bic", label: "BIC", placeholder: "DEUTDEDBXXX" },
    { key: "accountNumber", label: "Account number", placeholder: "0000000000" },
  ],
};

export const INSURANCE_DETAILS_SECTION: SectionConfig = {
  title: "Insurance details",
  description: "General liability and workers' compensation coverage.",
  group: "insuranceDetails",
  fields: [
    { key: "glCarrier", label: "GL carrier", placeholder: "Allianz" },
    { key: "glPolicyNumber", label: "GL policy number", placeholder: "GL-123456" },
    { key: "glCoverageLimit", label: "GL coverage limit", placeholder: "€2,000,000" },
    { key: "glExpiration", label: "GL expiration", type: "date" },
    { key: "wcCarrier", label: "WC carrier", placeholder: "Munich Re" },
    { key: "wcPolicyNumber", label: "WC policy number", placeholder: "WC-789012" },
    { key: "wcExpiration", label: "WC expiration", type: "date" },
    { key: "emr", label: "EMR", placeholder: "0.85" },
    { key: "emrEffectiveDate", label: "EMR effective date", type: "date" },
  ],
};

export const TENDER_INFO_SECTION: SectionConfig = {
  title: "Tender information",
  description: "What you do and where — this drives your tender matches.",
  group: "root",
  fields: [
    { key: "region", label: "Region", placeholder: "Bavaria" },
    { key: "businessDomain", label: "Business domain", placeholder: "Construction" },
    { key: "trade", label: "Trades & services", type: "tags", placeholder: "Add a trade and press Enter" },
    { key: "specializations", label: "Specializations", type: "tags", placeholder: "Add a specialization" },
    { key: "services", label: "Services", type: "tags", placeholder: "Add a service" },
    { key: "cpvCodes", label: "CPV codes", type: "tags", placeholder: "e.g. 45000000 - Construction work" },
    { key: "certifications", label: "Certifications", type: "tags", placeholder: "Add a certification" },
  ],
};

export const PROJECT_SIZE_SECTION: SectionConfig = {
  title: "Project size range",
  description: "Typical project value you bid on.",
  group: "projectSizeRange",
  fields: [
    { key: "min", label: "Minimum", placeholder: "€50,000" },
    { key: "max", label: "Maximum", placeholder: "€5,000,000" },
  ],
};

/** The business-certification checkboxes (KB businessCertifications). */
export const CERTIFICATION_FLAGS: Array<{ key: string; label: string }> = [
  { key: "sbe", label: "SBE — Small Business Enterprise" },
  { key: "lbe", label: "LBE — Local Business Enterprise" },
  { key: "dbe", label: "DBE — Disadvantaged Business Enterprise" },
  { key: "mbe", label: "MBE — Minority Business Enterprise" },
  { key: "wbe", label: "WBE — Women Business Enterprise" },
  { key: "wosb", label: "WOSB — Women-Owned Small Business" },
  { key: "hubzone", label: "HUBZone" },
  { key: "sdvosb", label: "SDVOSB — Service-Disabled Veteran-Owned" },
  { key: "vosb", label: "VOSB — Veteran-Owned Small Business" },
  { key: "eightA", label: "8(a) Business Development" },
];

/** The Company Information sidebar sections, in order (label + route slug). */
export const COMPANY_NAV = [
  { slug: "company-info", label: "Company info", icon: "Building2" },
  { slug: "company-details", label: "Company details", icon: "ClipboardList" },
  { slug: "principal-office", label: "Principal office", icon: "MapPin" },
  { slug: "mailing-address", label: "Mailing address", icon: "Mail" },
  { slug: "primary-contact", label: "Primary contact", icon: "UsersRound" },
  { slug: "financial-information", label: "Financial information", icon: "Landmark" },
  { slug: "insurance", label: "Insurance", icon: "ShieldCheck" },
  { slug: "certifications", label: "Certifications", icon: "BadgeCheck" },
  { slug: "documents", label: "Documents", icon: "FileText" },
] as const;

/** The top-level settings tabs (label + route path). */
export const SETTINGS_TABS = [
  { href: "/settings", label: "Company Information", match: "company" },
  { href: "/settings/tender-information", label: "Tender Information", match: "tender-information" },
  { href: "/settings/employee-information", label: "Employee Information", match: "employee-information" },
  { href: "/settings/billing", label: "Billing", match: "billing" },
  { href: "/settings/dora-playbook", label: "Dora-Playbook", match: "dora-playbook" },
] as const;
