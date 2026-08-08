/**
 * Full company context for the fit analysis — everything the company has
 * told us, not just the 11 signals the old prompt used. Takes a plain
 * serialized object (not a Mongoose document) so it is trivially testable.
 * Sections that are absent are skipped entirely; the model never sees empty
 * placeholders.
 */

export interface CompanyContextInput {
  name?: string | null;
  businessDomain?: string | null;
  region?: string | null;
  address?: string | null;
  employeeCount?: number | null;
  services?: string[];
  cpvCodes?: string[];
  trade?: string[];
  specializations?: string[];
  certifications?: string[];
  projectSizeRange?: { min?: string; max?: string } | null;
  insurances?: Array<{ type?: string; amount?: string; details?: string }>;
  referenceProjects?: Array<{
    title?: string;
    description?: string;
    client?: string;
    year?: string;
    value?: string;
  }>;
  knowledgeBase?: {
    companyExtended?: {
      legalForm?: string;
      foundingYear?: string;
      description?: string;
      registrationCourt?: string;
    };
    financialInfo?: {
      revenueCurrent?: string;
      revenueYear1?: string;
      revenueYear2?: string;
      revenueYear3?: string;
    };
    insuranceDetails?: {
      glCarrier?: string;
      glCoverageLimit?: string;
      glExpiration?: string;
      wcCarrier?: string;
      wcExpiration?: string;
      emr?: string;
    };
    bonding?: {
      suretyCompany?: string;
      bondingCapacity?: string;
      singleProjectLimit?: string;
    };
    technicalNarratives?: {
      safetyApproach?: string;
      qualityControlProcess?: string;
      capabilitiesStatement?: string;
      pastPerformanceSummary?: string;
    };
  } | null;
}

function line(label: string, value: string | number | null | undefined): string | null {
  if (value == null || value === "") return null;
  return `${label}: ${value}`;
}

function listLine(label: string, values: string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  return `${label}: ${values.join(", ")}`;
}

function section(title: string, lines: Array<string | null>): string | null {
  const present = lines.filter((entry): entry is string => entry != null);
  if (present.length === 0) return null;
  return [`## ${title}`, ...present].join("\n");
}

function truncate(text: string | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildFullCompanyContext(company: CompanyContextInput): string {
  const kb = company.knowledgeBase ?? {};

  const sections = [
    section("Identity", [
      line("Name", company.name),
      line("Business domain", company.businessDomain),
      line("Legal form", kb.companyExtended?.legalForm),
      line("Founded", kb.companyExtended?.foundingYear),
      line("Registration court", kb.companyExtended?.registrationCourt),
      line("Region/base", company.region),
      line("Address", company.address),
      line("Employees", company.employeeCount),
      company.projectSizeRange
        ? line(
            "Project size range",
            `${company.projectSizeRange.min ?? "?"} – ${company.projectSizeRange.max ?? "?"}`,
          )
        : null,
      truncate(kb.companyExtended?.description, 600),
    ]),
    section("Capabilities", [
      listLine("Services", company.services),
      listLine("Trades", company.trade),
      listLine("Specializations", company.specializations),
      listLine("CPV codes", company.cpvCodes),
      truncate(kb.technicalNarratives?.capabilitiesStatement, 800),
    ]),
    section("Certifications", [
      listLine("Certifications", company.certifications),
    ]),
    section("Financials", [
      line("Revenue (current year)", kb.financialInfo?.revenueCurrent),
      line("Revenue (year -1)", kb.financialInfo?.revenueYear1),
      line("Revenue (year -2)", kb.financialInfo?.revenueYear2),
      line("Revenue (year -3)", kb.financialInfo?.revenueYear3),
    ]),
    section("Insurance", [
      ...(company.insurances ?? []).map((insurance) =>
        line(
          insurance.type ?? "Insurance",
          [insurance.amount, insurance.details].filter(Boolean).join(" — "),
        ),
      ),
      line("GL carrier", kb.insuranceDetails?.glCarrier),
      line("GL coverage limit", kb.insuranceDetails?.glCoverageLimit),
      line("GL expiration", kb.insuranceDetails?.glExpiration),
      line("WC carrier", kb.insuranceDetails?.wcCarrier),
      line("EMR", kb.insuranceDetails?.emr),
    ]),
    section("Bonding", [
      line("Surety", kb.bonding?.suretyCompany),
      line("Bonding capacity", kb.bonding?.bondingCapacity),
      line("Single project limit", kb.bonding?.singleProjectLimit),
    ]),
    section(
      "Reference projects",
      (company.referenceProjects ?? []).map((project) =>
        line(
          project.title ?? "Project",
          [
            project.client && `client: ${project.client}`,
            project.year && `year: ${project.year}`,
            project.value && `value: ${project.value}`,
            project.description && truncate(project.description, 200),
          ]
            .filter(Boolean)
            .join("; "),
        ),
      ),
    ),
    section("Track record & quality", [
      truncate(kb.technicalNarratives?.pastPerformanceSummary, 600),
      truncate(kb.technicalNarratives?.qualityControlProcess, 400),
      truncate(kb.technicalNarratives?.safetyApproach, 400),
    ]),
  ];

  return sections.filter((entry): entry is string => entry != null).join("\n\n");
}
