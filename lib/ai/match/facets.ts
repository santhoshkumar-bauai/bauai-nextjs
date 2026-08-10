import {
  line,
  listLine,
  section,
  truncate,
  type CompanyContextInput,
} from "../fit/company-context.ts";

/**
 * The company, rendered as several independent query texts ("facets").
 *
 * One vector per company does not work: averaging "we build roofs" with "our
 * surety is X" and "ISO 9001 certified" produces a vector that resembles none
 * of them and retrieves generically. Keeping the company's capabilities apart
 * also buys explainability for free — the facet that retrieved a tender is
 * what the card shows as "matched via your reference project …".
 *
 * This module is deliberately pure: no I/O, no gateway, no Mongo. Everything
 * that needs the network (CPV name resolution, chunk lookup, embedding) is
 * passed in by `lib/ai/match/company-profile.ts`.
 */

/**
 * Bump whenever anything in THIS file changes what a profile would come out
 * as — facet composition, text assembly, or weights. The staleness check keys
 * on the company's data, which does not change when our code does, so without
 * a bump every existing profile silently keeps its old facets and weights.
 *
 * v2: document-facet weights share one fixed budget instead of growing with
 * the document count.
 * v3: facets are category-aware — logo/insurance uploads are no longer
 * retrieval facets, reference-project uploads carry their own budget. The
 * bump also forces a rebuild that picks up the fixed CPV-name resolution
 * (profiles built before the fix have no "Procurement categories" line).
 * v4: reference-doc budget 1.4 → 2.8 so uploaded evidence can out-vote a
 * thin typed profile.
 */
export const MATCH_PROFILE_VERSION = "match-profile-v4";

/**
 * Below this a facet is skipped rather than embedded. A three-word facet still
 * produces a unit vector, and that vector points somewhere arbitrary — it adds
 * a full retrieval arm of noise. Absent is better than arbitrary.
 */
export const MIN_FACET_CHARS = 120;

/** Per-facet text budget. Beyond this the tail stops carrying signal. */
const MAX_FACET_CHARS = 4000;

const MAX_REFERENCE_FACETS = 8;

export type FacetKind = "profile" | "document";

export interface FacetDraft {
  key: string;
  kind: FacetKind;
  label: string | null;
  weight: number;
  text: string;
}

export interface SkippedFacet {
  key: string;
  reason: "too_short" | "absent";
}

/** A company document reduced to the text we want to embed as a query. */
export interface DocumentFacetInput {
  documentRecordId: string;
  fileName: string | null;
  /** User-picked `companyfiles.category`; null/unknown behaves as "general". */
  category?: string | null;
  text: string;
}

export interface BuildFacetsInput {
  company: CompanyContextInput;
  /**
   * CPV codes resolved to human names, e.g. "45210000" → "Hochbauarbeiten".
   * This is the single highest-leverage input here: "45210000" embeds as
   * noise, "Hochbauarbeiten" embeds as meaning, which is most of what rescues
   * a company whose profile is otherwise just a list of codes.
   */
  cpvNames: string[];
  documents: DocumentFacetInput[];
  maxFacets: number;
}

export interface BuildFacetsResult {
  facets: FacetDraft[];
  skipped: SkippedFacet[];
}

const WEIGHT_CAPABILITIES = 1.0;
const WEIGHT_REFERENCES = 0.7;
const WEIGHT_QUALIFICATIONS = 0.35;
/**
 * The document corpus shares ONE fixed budget, split evenly, rather than each
 * document carrying its own weight.
 *
 * Without this, a company that uploads twelve PDFs out-votes its own
 * capabilities statement twelve-to-one, and the feed drifts toward whatever
 * the paperwork happens to discuss — insurance wording, boilerplate terms —
 * instead of what the company actually builds. The invariant is that the
 * documents together are worth `DOC_WEIGHT_BUDGET` against the capabilities
 * facet's 1.0, no matter how many there are.
 */
const DOC_WEIGHT_BUDGET = 0.55;

/**
 * Reference-project uploads get their own, larger budget.
 *
 * A reference-project PDF is the closest thing to ground truth about what the
 * company actually does — for Wirl Ing the uploads say "electrical / TGA
 * planning office" while the typed profile says "Construction work". The
 * budget is sized so that a company's reference documents can out-vote a
 * thin typed profile: evidence of delivered work beats a generic claim.
 * Measured at 1.4 the four Wirl uploads (0.35 each) lost every fusion round
 * to capabilities + text + rule (≈2.5 combined) and not one electrical
 * tender reached the top 30; at 2.8 the offline counterfactual put 13 in.
 *
 * Still a budget with a per-doc cap, not a flat per-doc weight: ten uploads
 * at a flat 0.7 would carry 7.0 of RRF mass and out-vote everything else —
 * exactly the failure v2 exists to prevent.
 */
const REF_DOC_WEIGHT_BUDGET = 2.8;

export function documentFacetWeight(documentCount: number): number {
  if (documentCount <= 0) return 0;
  return DOC_WEIGHT_BUDGET / documentCount;
}

export function referenceDocFacetWeight(documentCount: number): number {
  if (documentCount <= 0) return 0;
  return Math.min(WEIGHT_REFERENCES, REF_DOC_WEIGHT_BUDGET / documentCount);
}

function clamp(text: string): string {
  return text.length > MAX_FACET_CHARS ? `${text.slice(0, MAX_FACET_CHARS)}…` : text;
}

function joinSections(sections: Array<string | null>): string {
  return sections.filter((entry): entry is string => entry != null).join("\n\n");
}

/** Identity + what the company can actually do. The primary retrieval arm. */
function capabilitiesText(company: CompanyContextInput, cpvNames: string[]): string {
  const kb = company.knowledgeBase ?? {};
  return joinSections([
    section("Identity", [
      line("Name", company.name),
      line("Business domain", company.businessDomain),
      line("Region/base", company.region),
      truncate(kb.companyExtended?.description, 800),
    ]),
    section("Capabilities", [
      listLine("Services", company.services),
      listLine("Trades", company.trade),
      listLine("Specializations", company.specializations),
      // Names, not codes — see BuildFacetsInput.cpvNames.
      listLine("Procurement categories", cpvNames),
      truncate(kb.technicalNarratives?.capabilitiesStatement, 1200),
    ]),
  ]);
}

/** Delivered work. Matches tenders that describe a similar project. */
function referenceText(
  project: NonNullable<CompanyContextInput["referenceProjects"]>[number],
): string {
  return joinSections([
    section(project.title?.trim() || "Reference project", [
      line("Client", project.client),
      line("Year", project.year),
      line("Value", project.value),
      truncate(project.description, 2000),
    ]),
  ]);
}

/**
 * Certifications, cover and capacity — the eligibility side. Weighted lowest
 * because it discriminates between tenders far less than capability does:
 * most public works tenders want the same handful of proofs.
 */
function qualificationsText(company: CompanyContextInput): string {
  const kb = company.knowledgeBase ?? {};
  return joinSections([
    section("Qualifications", [
      listLine("Certifications", company.certifications),
      line("Employees", company.employeeCount),
      company.projectSizeRange
        ? line(
            "Project size range",
            `${company.projectSizeRange.min ?? "?"} – ${company.projectSizeRange.max ?? "?"}`,
          )
        : null,
      ...(company.insurances ?? []).map((insurance) =>
        line(
          insurance.type ?? "Insurance",
          [insurance.amount, insurance.details].filter(Boolean).join(" — "),
        ),
      ),
      line("Bonding capacity", kb.bonding?.bondingCapacity),
      line("Single project limit", kb.bonding?.singleProjectLimit),
    ]),
    section("Track record & quality", [
      truncate(kb.technicalNarratives?.pastPerformanceSummary, 800),
      truncate(kb.technicalNarratives?.qualityControlProcess, 600),
      truncate(kb.technicalNarratives?.safetyApproach, 400),
    ]),
  ]);
}

/**
 * Build the company's facet set. Facets that cannot be built, or that come out
 * too thin to be worth a retrieval arm, are reported in `skipped` so the UI can
 * tell the user exactly which part of their profile is holding matching back.
 */
export function buildCompanyFacets(input: BuildFacetsInput): BuildFacetsResult {
  const { company, cpvNames, documents, maxFacets } = input;
  const facets: FacetDraft[] = [];
  const skipped: SkippedFacet[] = [];

  const consider = (draft: FacetDraft): void => {
    const text = draft.text.trim();
    if (text.length === 0) {
      skipped.push({ key: draft.key, reason: "absent" });
      return;
    }
    if (text.length < MIN_FACET_CHARS) {
      skipped.push({ key: draft.key, reason: "too_short" });
      return;
    }
    facets.push({ ...draft, text: clamp(text) });
  };

  consider({
    key: "capabilities",
    kind: "profile",
    label: null,
    weight: WEIGHT_CAPABILITIES,
    text: capabilitiesText(company, cpvNames),
  });

  const projects = (company.referenceProjects ?? []).slice(0, MAX_REFERENCE_FACETS);
  for (const [index, project] of projects.entries()) {
    consider({
      key: `reference:${index}`,
      kind: "profile",
      label: project.title?.trim() || null,
      weight: WEIGHT_REFERENCES,
      text: referenceText(project),
    });
  }

  consider({
    key: "qualifications",
    kind: "profile",
    label: null,
    weight: WEIGHT_QUALIFICATIONS,
    text: qualificationsText(company),
  });

  // Document facets are weighted only once we know how many survive, so the
  // budget is split across the real count rather than the attempted one.
  const documentDrafts: Array<{ draft: FacetDraft; isReference: boolean }> = [];
  const documentSkips: SkippedFacet[] = [];
  for (const doc of documents) {
    const key = `doc:${doc.documentRecordId}`;
    const text = doc.text.trim();
    if (text.length === 0) {
      documentSkips.push({ key, reason: "absent" });
      continue;
    }
    if (text.length < MIN_FACET_CHARS) {
      documentSkips.push({ key, reason: "too_short" });
      continue;
    }
    documentDrafts.push({
      draft: {
        key,
        kind: "document",
        label: doc.fileName,
        weight: 0,
        text: clamp(text),
      },
      isReference: doc.category === "reference-project",
    });
  }

  // Profile facets win the budget when it is tight: they are the deliberate
  // description of the company, documents are whatever happened to be
  // uploaded. Among documents, reference projects win the room — they are
  // evidence of delivered work, the rest is paperwork.
  const roomForDocuments = Math.max(0, maxFacets - facets.length);
  const keptDocuments = [...documentDrafts]
    .sort((a, b) => Number(b.isReference) - Number(a.isReference))
    .slice(0, roomForDocuments);

  const referenceCount = keptDocuments.filter((doc) => doc.isReference).length;
  const generalCount = keptDocuments.length - referenceCount;
  const referenceWeight = referenceDocFacetWeight(referenceCount);
  const generalWeight = documentFacetWeight(generalCount);

  for (const { draft, isReference } of keptDocuments) {
    facets.push({ ...draft, weight: isReference ? referenceWeight : generalWeight });
  }
  skipped.push(...documentSkips);

  return { facets: facets.slice(0, maxFacets), skipped };
}
