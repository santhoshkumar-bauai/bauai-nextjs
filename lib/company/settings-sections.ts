/**
 * Field configuration for the company-settings section forms. Plain data (no
 * React / no server imports) so both client form components and the section
 * pages can share it.
 *
 * All user-visible copy lives in `messages/{en,de}.json` under the `Settings`
 * namespace — this file only carries message ids and structural metadata so the
 * whole settings surface renders in English and German. `sample` values are
 * language-neutral examples (proper nouns / numbers) shown as input
 * placeholders; instructional placeholders come from translations instead.
 *
 * Each section maps to a slice of the company profile via `group`:
 * - `root`             -> top-level Company fields
 * - `bankDetails`      -> Company.bankDetails
 * - `projectSizeRange` -> Company.projectSizeRange
 * - a knowledgeBase key -> Company.knowledgeBase[key]
 */

export type FieldType = "text" | "email" | "number" | "date" | "textarea" | "tags";

export type FieldDef = {
  key: string;
  type?: FieldType;
  /** Language-neutral example placeholder (e.g. "GmbH", "€5,000,000"). */
  sample?: string;
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
  /** Message id under `Settings.sections.<id>` for title, description, fields. */
  id: string;
  group: SectionGroup;
  fields: FieldDef[];
};

export const COMPANY_INFO_SECTION: SectionConfig = {
  id: "companyInfo",
  group: "root",
  fields: [
    { key: "name", sample: "BAU AI" },
    { key: "email", type: "email", sample: "info@bauai.eu" },
    { key: "website", sample: "bauai.eu" },
    { key: "phone", sample: "+49 89 123456" },
    { key: "employeeCount", type: "number", sample: "50" },
    { key: "registrationNumber", sample: "1234567890" },
    { key: "vatNumber", sample: "DE123456789" },
    { key: "address", sample: "Leopoldstrasse 1, München" },
  ],
};

export const COMPANY_DETAILS_SECTION: SectionConfig = {
  id: "companyDetails",
  group: "companyExtended",
  fields: [
    { key: "legalForm", sample: "GmbH" },
    { key: "foundingYear", sample: "2008" },
    { key: "registrationCourt", sample: "Amtsgericht München" },
    { key: "description", type: "textarea" },
  ],
};

export const PRINCIPAL_OFFICE_SECTION: SectionConfig = {
  id: "principalOffice",
  group: "principalOffice",
  fields: [
    { key: "streetAddress", sample: "Leopoldstrasse 1" },
    { key: "city", sample: "München" },
    { key: "state", sample: "Bayern" },
    { key: "zipCode", sample: "80331" },
    { key: "county", sample: "München" },
    { key: "country", sample: "Deutschland" },
  ],
};

export const MAILING_ADDRESS_SECTION: SectionConfig = {
  id: "mailingAddress",
  group: "mailingAddress",
  fields: [
    { key: "address", sample: "Postfach 123" },
    { key: "city", sample: "München" },
    { key: "state", sample: "Bayern" },
    { key: "zipCode", sample: "80331" },
  ],
};

export const PRIMARY_CONTACT_SECTION: SectionConfig = {
  id: "primaryContact",
  group: "primaryContact",
  fields: [
    { key: "firstName", sample: "Jane" },
    { key: "lastName", sample: "Doe" },
    { key: "title", sample: "Projektleiterin" },
    { key: "role", sample: "Lead Engineer" },
    { key: "email", type: "email", sample: "jane@company.com" },
    { key: "phone", sample: "+49 89 123456" },
  ],
};

export const FINANCIAL_INFO_SECTION: SectionConfig = {
  id: "financialInfo",
  group: "financialInfo",
  fields: [
    { key: "revenueCurrent", sample: "€5,000,000" },
    { key: "revenueYear1", sample: "€4,500,000" },
    { key: "revenueYear2", sample: "€4,000,000" },
    { key: "revenueYear3", sample: "€3,500,000" },
  ],
};

export const BANK_DETAILS_SECTION: SectionConfig = {
  id: "bankDetails",
  group: "bankDetails",
  fields: [
    { key: "bankName", sample: "Deutsche Bank" },
    { key: "accountHolder", sample: "BAU AI GmbH" },
    { key: "iban", sample: "DE00 0000 0000 0000 0000 00" },
    { key: "bic", sample: "DEUTDEDBXXX" },
    { key: "accountNumber", sample: "0000000000" },
  ],
};

export const INSURANCE_DETAILS_SECTION: SectionConfig = {
  id: "insuranceDetails",
  group: "insuranceDetails",
  fields: [
    { key: "glCarrier", sample: "Allianz" },
    { key: "glPolicyNumber", sample: "GL-123456" },
    { key: "glCoverageLimit", sample: "€2,000,000" },
    { key: "glExpiration", type: "date" },
    { key: "wcCarrier", sample: "Munich Re" },
    { key: "wcPolicyNumber", sample: "WC-789012" },
    { key: "wcExpiration", type: "date" },
    { key: "emr", sample: "0.85" },
    { key: "emrEffectiveDate", type: "date" },
  ],
};

export const TENDER_INFO_SECTION: SectionConfig = {
  id: "tenderInfo",
  group: "root",
  fields: [
    { key: "region", sample: "Bayern" },
    { key: "businessDomain", sample: "Construction" },
    { key: "trade", type: "tags" },
    { key: "specializations", type: "tags" },
    { key: "services", type: "tags" },
    { key: "cpvCodes", type: "tags" },
    { key: "certifications", type: "tags" },
  ],
};

export const PROJECT_SIZE_SECTION: SectionConfig = {
  id: "projectSize",
  group: "projectSizeRange",
  fields: [
    { key: "min", sample: "€50,000" },
    { key: "max", sample: "€5,000,000" },
  ],
};

/** Business-certification checkboxes; labels come from Settings.certificationFlags. */
export const CERTIFICATION_FLAGS = [
  "sbe",
  "lbe",
  "dbe",
  "mbe",
  "wbe",
  "wosb",
  "hubzone",
  "sdvosb",
  "vosb",
  "eightA",
] as const;

/** Company Information sidebar sections (label key under Settings.sidebar). */
export const COMPANY_NAV = [
  { slug: "company-info", labelKey: "companyInfo", icon: "Building2" },
  { slug: "company-details", labelKey: "companyDetails", icon: "ClipboardList" },
  { slug: "principal-office", labelKey: "principalOffice", icon: "MapPin" },
  { slug: "mailing-address", labelKey: "mailingAddress", icon: "Mail" },
  { slug: "primary-contact", labelKey: "primaryContact", icon: "UsersRound" },
  { slug: "financial-information", labelKey: "financialInformation", icon: "Landmark" },
  { slug: "insurance", labelKey: "insurance", icon: "ShieldCheck" },
  { slug: "certifications", labelKey: "certifications", icon: "BadgeCheck" },
  { slug: "documents", labelKey: "documents", icon: "FileText" },
] as const;

/** Top-level settings tabs (label key under Settings.tabs). */
export const SETTINGS_TABS = [
  { href: "/settings", tabKey: "company", match: "company" },
  { href: "/settings/tender-information", tabKey: "tender", match: "tender-information" },
  { href: "/settings/employee-information", tabKey: "employees", match: "employee-information" },
  { href: "/settings/billing", tabKey: "billing", match: "billing" },
  { href: "/settings/clara-playbook", tabKey: "clara", match: "clara-playbook" },
] as const;

/** Document categories (label/description keys under Settings.documents.categories). */
export const DOCUMENT_CATEGORIES = [
  "general",
  "insurance",
  "certification",
  "reference-project",
] as const;
