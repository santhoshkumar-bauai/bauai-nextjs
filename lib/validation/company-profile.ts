import type {
  BankDetails,
  CompanyContactPerson,
  CompanyKnowledgeBase,
  InsuranceInfo,
  ReferenceProject,
} from "@/models/company";

/**
 * Sanitizers for the company-details update payload. The client sends a partial
 * profile; these turn the untrusted JSON into a typed, whitelisted `$set` that
 * can never touch protected fields (domain, members, trial, createdBy).
 *
 * Every helper is defensive: unexpected shapes collapse to a safe empty value
 * rather than throwing, so one malformed field can't reject an otherwise valid
 * save.
 */

const MAX_STRING = 5000;

function str(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, MAX_STRING);
  return trimmed.length > 0 ? trimmed : undefined;
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nonNegInt(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

/** Drops keys whose value is undefined; returns undefined if nothing remains. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? (Object.fromEntries(entries) as Partial<T>) : undefined;
}

function contactPerson(value: unknown): CompanyContactPerson | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  return compact({
    name: str(v.name),
    firstName: str(v.firstName),
    lastName: str(v.lastName),
    title: str(v.title),
    role: str(v.role),
    email: str(v.email),
    phone: str(v.phone),
  });
}

function bankDetails(value: unknown): BankDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  return compact({
    bankName: str(v.bankName),
    accountNumber: str(v.accountNumber),
    accountHolder: str(v.accountHolder),
    iban: str(v.iban),
    bic: str(v.bic),
  });
}

function insurances(value: unknown): InsuranceInfo[] {
  if (!Array.isArray(value)) return [];
  const result: InsuranceInfo[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const type = str(v.type);
    const amount = str(v.amount);
    if (!type || !amount) continue;
    const entry: InsuranceInfo = { type, amount };
    const details = str(v.details);
    if (details !== undefined) entry.details = details;
    result.push(entry);
  }
  return result;
}

function referenceProjects(value: unknown): ReferenceProject[] {
  if (!Array.isArray(value)) return [];
  const result: ReferenceProject[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const v = item as Record<string, unknown>;
    const title = str(v.title);
    const description = str(v.description);
    if (!title || !description) continue;
    const entry: ReferenceProject = { title, description };
    const client = str(v.client);
    const year = str(v.year);
    const projectValue = str(v.value);
    if (client !== undefined) entry.client = client;
    if (year !== undefined) entry.year = year;
    if (projectValue !== undefined) entry.value = projectValue;
    result.push(entry);
  }
  return result;
}

function knowledgeBase(value: unknown): CompanyKnowledgeBase | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const obj = (key: string) =>
    v[key] && typeof v[key] === "object"
      ? (v[key] as Record<string, unknown>)
      : {};

  const companyExtended = compact({
    legalForm: str(obj("companyExtended").legalForm),
    foundingYear: str(obj("companyExtended").foundingYear),
    description: str(obj("companyExtended").description),
    registrationCourt: str(obj("companyExtended").registrationCourt),
  });
  const principalOffice = compact({
    streetAddress: str(obj("principalOffice").streetAddress),
    city: str(obj("principalOffice").city),
    state: str(obj("principalOffice").state),
    zipCode: str(obj("principalOffice").zipCode),
    county: str(obj("principalOffice").county),
    country: str(obj("principalOffice").country),
  });
  const mailingAddress = compact({
    address: str(obj("mailingAddress").address),
    city: str(obj("mailingAddress").city),
    state: str(obj("mailingAddress").state),
    zipCode: str(obj("mailingAddress").zipCode),
  });
  const contactInfo = compact({
    mainPhone: str(obj("contactInfo").mainPhone),
    mobile: str(obj("contactInfo").mobile),
    fax: str(obj("contactInfo").fax),
    email: str(obj("contactInfo").email),
    website: str(obj("contactInfo").website),
  });
  const financialInfo = compact({
    revenueCurrent: str(obj("financialInfo").revenueCurrent),
    revenueYear1: str(obj("financialInfo").revenueYear1),
    revenueYear2: str(obj("financialInfo").revenueYear2),
    revenueYear3: str(obj("financialInfo").revenueYear3),
  });
  const bankExtended = compact({
    bankAddress: str(obj("bankExtended").bankAddress),
    bankCity: str(obj("bankExtended").bankCity),
    bankState: str(obj("bankExtended").bankState),
    contactName: str(obj("bankExtended").contactName),
    bankPhone: str(obj("bankExtended").bankPhone),
  });
  const insuranceDetails = compact({
    glCarrier: str(obj("insuranceDetails").glCarrier),
    glPolicyNumber: str(obj("insuranceDetails").glPolicyNumber),
    glCoverageLimit: str(obj("insuranceDetails").glCoverageLimit),
    glExpiration: str(obj("insuranceDetails").glExpiration),
    wcCarrier: str(obj("insuranceDetails").wcCarrier),
    wcPolicyNumber: str(obj("insuranceDetails").wcPolicyNumber),
    wcExpiration: str(obj("insuranceDetails").wcExpiration),
    emr: str(obj("insuranceDetails").emr),
    emrEffectiveDate: str(obj("insuranceDetails").emrEffectiveDate),
  });
  const bonding = compact({
    suretyCompany: str(obj("bonding").suretyCompany),
    agentName: str(obj("bonding").agentName),
    agentCompany: str(obj("bonding").agentCompany),
    agentPhone: str(obj("bonding").agentPhone),
    agentEmail: str(obj("bonding").agentEmail),
    bondingCapacity: str(obj("bonding").bondingCapacity),
    singleProjectLimit: str(obj("bonding").singleProjectLimit),
  });
  const businessCertifications = compact({
    sbe: bool(obj("businessCertifications").sbe),
    lbe: bool(obj("businessCertifications").lbe),
    dbe: bool(obj("businessCertifications").dbe),
    mbe: bool(obj("businessCertifications").mbe),
    wbe: bool(obj("businessCertifications").wbe),
    wosb: bool(obj("businessCertifications").wosb),
    hubzone: bool(obj("businessCertifications").hubzone),
    sdvosb: bool(obj("businessCertifications").sdvosb),
    vosb: bool(obj("businessCertifications").vosb),
    eightA: bool(obj("businessCertifications").eightA),
    otherCertifications: str(obj("businessCertifications").otherCertifications),
  });
  const technicalNarratives = compact({
    safetyApproach: str(obj("technicalNarratives").safetyApproach),
    qualityControlProcess: str(obj("technicalNarratives").qualityControlProcess),
    capabilitiesStatement: str(obj("technicalNarratives").capabilitiesStatement),
    pastPerformanceSummary: str(obj("technicalNarratives").pastPerformanceSummary),
  });

  return compact({
    companyExtended,
    principalOffice,
    mailingAddress,
    contactInfo,
    primaryContact: contactPerson(v.primaryContact),
    authorizedSigner: contactPerson(v.authorizedSigner),
    financialInfo,
    bankExtended,
    insuranceDetails,
    bonding,
    businessCertifications,
    technicalNarratives,
  });
}

/**
 * Builds the whitelisted `$set` update from an untrusted request body. Only keys
 * present in the body are included, so a PATCH updates just what it sends. The
 * company's domain, members, trial, and ownership are intentionally not
 * settable here.
 */
export function buildCompanyProfileUpdate(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const setIf = (key: string, value: unknown) => {
    if (has(key)) update[key] = value;
  };

  setIf("name", str(body.name));
  setIf("website", str(body.website));
  setIf("businessDomain", str(body.businessDomain));
  setIf("region", str(body.region));
  setIf("companyDomain", str(body.companyDomain));
  setIf("companyDomainOther", str(body.companyDomainOther));
  setIf("email", str(body.email));
  setIf("phone", str(body.phone));
  setIf("vatNumber", str(body.vatNumber));
  setIf("registrationNumber", str(body.registrationNumber));
  setIf("address", str(body.address));
  setIf("employeeCount", nonNegInt(body.employeeCount));

  if (has("services")) update.services = strList(body.services);
  if (has("cpvCodes")) update.cpvCodes = strList(body.cpvCodes);
  if (has("trade")) update.trade = strList(body.trade);
  if (has("specializations")) update.specializations = strList(body.specializations);
  if (has("certifications")) update.certifications = strList(body.certifications);

  // Region coordinates from the Places picker (same shape onboarding writes).
  // Without this handler a region change via settings silently drops the
  // coordinates and geo matching keeps using the stale onboarding location.
  if (has("regionLocation")) {
    const location = body.regionLocation;
    if (location && typeof location === "object") {
      const record = location as Record<string, unknown>;
      const placeId = str(record.placeId);
      const latitude = record.latitude;
      const longitude = record.longitude;
      if (
        placeId &&
        typeof latitude === "number" &&
        latitude >= -90 &&
        latitude <= 90 &&
        typeof longitude === "number" &&
        longitude >= -180 &&
        longitude <= 180
      ) {
        update.regionLocation = { placeId, latitude, longitude };
      } else {
        update.regionLocation = undefined;
      }
    } else {
      update.regionLocation = undefined;
    }
  }

  if (has("addressCoordinates")) {
    const c = body.addressCoordinates;
    if (c && typeof c === "object") {
      const lat = (c as Record<string, unknown>).lat;
      const lng = (c as Record<string, unknown>).lng;
      if (
        typeof lat === "number" &&
        lat >= -90 &&
        lat <= 90 &&
        typeof lng === "number" &&
        lng >= -180 &&
        lng <= 180
      ) {
        update.addressCoordinates = { lat, lng };
      } else {
        update.addressCoordinates = undefined;
      }
    } else {
      update.addressCoordinates = undefined;
    }
  }

  if (has("projectSizeRange")) {
    const r = body.projectSizeRange;
    update.projectSizeRange =
      r && typeof r === "object"
        ? compact({
            min: str((r as Record<string, unknown>).min),
            max: str((r as Record<string, unknown>).max),
          })
        : undefined;
  }

  if (has("bankDetails")) update.bankDetails = bankDetails(body.bankDetails);
  if (has("insurances")) update.insurances = insurances(body.insurances);
  if (has("referenceProjects"))
    update.referenceProjects = referenceProjects(body.referenceProjects);
  if (has("knowledgeBase"))
    update.knowledgeBase = knowledgeBase(body.knowledgeBase);

  return update;
}
