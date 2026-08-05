import type { SerializedCompanyProfile } from "@/lib/company/serialize";

/**
 * A rough profile-completion percentage for the sidebar meter. Counts a
 * representative set of profile signals; not an exhaustive audit, just enough to
 * nudge the user toward a fuller profile.
 */
export function computeProfileCompletion(
  profile: SerializedCompanyProfile,
): number {
  const kb = profile.knowledgeBase ?? {};
  const filled = (value: unknown) =>
    Array.isArray(value)
      ? value.length > 0
      : value !== null && value !== undefined && String(value).trim() !== "";

  const checks: boolean[] = [
    filled(profile.name),
    filled(profile.email),
    filled(profile.website),
    filled(profile.phone),
    filled(profile.employeeCount),
    filled(profile.vatNumber),
    filled(profile.registrationNumber),
    filled(profile.address),
    filled(profile.region),
    filled(profile.businessDomain),
    filled(profile.trade),
    filled(profile.cpvCodes),
    filled(profile.services),
    filled(profile.bankDetails?.iban),
    filled(profile.insurances),
    filled(kb.companyExtended?.legalForm),
    filled(kb.companyExtended?.foundingYear),
    filled(kb.companyExtended?.description),
    filled(kb.principalOffice?.city),
    filled(kb.primaryContact?.email),
    filled(kb.financialInfo?.revenueCurrent),
    filled(kb.insuranceDetails?.glCarrier),
  ];

  const done = checks.filter(Boolean).length;
  return Math.round((done / checks.length) * 100);
}
