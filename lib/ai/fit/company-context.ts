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
  /**
   * `cpvCodes` resolved to catalog names ("Bauleistungen im Hochbau / Building
   * construction work"). When present they replace the raw codes in the
   * rendered context: "45210000-2" tells the model nothing, the name is the
   * capability. Optional so existing call sites keep their exact output.
   */
  cpvNames?: string[];
  trade?: string[];
  specializations?: string[];
  certifications?: string[];
  /**
   * Uploaded documents on file, as evidence that capability claims are
   * backed by paperwork. `excerpt` carries the opening of the document's
   * extracted text — without it the judge sees only a filename and cannot
   * know that "Abbenrode_Anbau_Feuerwehr.docx" describes electrical work.
   */
  documents?: Array<{ fileName: string; category: string; excerpt?: string }>;
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

// Exported so the match-facet builder (lib/ai/match/facets.ts) renders company
// data exactly the way the fit prompt does — one formatting convention, so the
// two can never drift into describing the same company differently.
export function line(
  label: string,
  value: string | number | null | undefined,
): string | null {
  if (value == null || value === "") return null;
  return `${label}: ${value}`;
}

export function listLine(label: string, values: string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  return `${label}: ${values.join(", ")}`;
}

export function section(title: string, lines: Array<string | null>): string | null {
  const present = lines.filter((entry): entry is string => entry != null);
  if (present.length === 0) return null;
  return [`## ${title}`, ...present].join("\n");
}

export function truncate(text: string | undefined, max: number): string | null {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildFullCompanyContext(company: CompanyContextInput): string {
  const kb = company.knowledgeBase ?? {};

  // Capabilities lead and the money/insurance trivia trails: consumers cap
  // this text (the match judge at 6000 chars) and truncation eats the TAIL,
  // so the order is also a statement about what may be lost. Losing the GL
  // carrier is harmless; losing the reference projects would blind the judge
  // to what the company actually does.
  const sections = [
    section("Capabilities", [
      listLine("Services", company.services),
      listLine("Trades", company.trade),
      listLine("Specializations", company.specializations),
      // Names when the caller resolved them — the code list is a fallback,
      // not an equal: "45210000-2" carries no meaning for the judge.
      company.cpvNames?.length
        ? listLine("Procurement categories", company.cpvNames)
        : listLine("CPV codes", company.cpvCodes),
      truncate(kb.technicalNarratives?.capabilitiesStatement, 800),
    ]),
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
    section("Reference projects",
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
    section(
      "Documents on file",
      (company.documents ?? [])
        .slice(0, 12)
        .flatMap((doc) => [
          line(doc.category, doc.fileName),
          // Indented so the excerpt reads as belonging to the file above it.
          doc.excerpt ? `  ${truncate(doc.excerpt.replace(/\s+/g, " "), 350)}` : null,
        ]),
    ),
    section("Certifications", [
      listLine("Certifications", company.certifications),
    ]),
    section("Track record & quality", [
      truncate(kb.technicalNarratives?.pastPerformanceSummary, 600),
      truncate(kb.technicalNarratives?.qualityControlProcess, 400),
      truncate(kb.technicalNarratives?.safetyApproach, 400),
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
  ];

  return sections.filter((entry): entry is string => entry != null).join("\n\n");
}
