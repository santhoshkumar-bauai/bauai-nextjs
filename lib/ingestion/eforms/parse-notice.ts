import { missingIdentity } from "../http/errors.ts";
import type {
  CanonicalAddress,
  CanonicalBuyer,
  CanonicalDocument,
  CanonicalLot,
  CanonicalMoney,
  DeadlineKind,
  DiscoveredNotice,
  LocalizedText,
  RawNotice,
  SourceNotice,
  ValidationStatus,
} from "../types.ts";
import { parseOffsetDateTime } from "../utils/time.ts";
import {
  countryFromNuts,
  normalizeCpv,
  normalizeCurrency,
  parseAmount,
  toCountryAlpha2,
  toLanguageCode,
  toRegionCode,
} from "./codelists.ts";
import { classifyNoticeType, isKnownNoticeType } from "./notice-types.ts";
import {
  attribute,
  child,
  children,
  collectDescendants,
  documentElement,
  findBySchemeName,
  parseXml,
  path,
  text,
  textAt,
  type XmlNode,
} from "./xml.ts";

export const EFORMS_PARSER_VERSION = "eforms-ubl-1.0.0";
export const EFORMS_SCHEMA_VERSION = 1;

/**
 * Placeholder OJS identifier used by national notices that were never sent to
 * TED. Treating it as a real publication number would create false cross-source
 * links, which section 8.2 explicitly forbids.
 */
const OJS_PLACEHOLDER = /^0+-\d+$/;

export interface EformsParseContext {
  /** Version key resolved by the pipeline before parsing (§8.1). */
  versionKey: string;
  discoveredUrl: string | null;
}

/**
 * Shared eForms UBL parser.
 *
 * Germany and TED both publish eForms UBL, so one parser serves both and there
 * is a single place where a mapping fix lands. Source-specific behaviour stays
 * in the adapters, which own discovery, fetching, and licence metadata.
 */
export function parseEformsNotice(
  raw: RawNotice,
  ref: DiscoveredNotice,
  context: EformsParseContext,
): SourceNotice {
  const document = parseXml(raw.body, `${raw.source}:${raw.sourceNoticeId}`);
  const root = documentElement(document);
  if (!root) {
    throw missingIdentity(`${raw.source} notice has no document element`);
  }

  const node = root.node;
  const warnings: string[] = [];

  const noticeId = readNoticeId(node) ?? ref.sourceNoticeId;
  if (!noticeId) {
    throw missingIdentity(
      `${raw.source} notice is missing a stable notice id; quarantined rather than assigned a random identity`,
    );
  }

  const typeNode = child(node, "NoticeTypeCode");
  const typeCode = text(typeNode);
  const formType = attribute(typeNode, "listName");
  const notice = classifyNoticeType(typeCode, readSubtype(node), formType);
  if (!isKnownNoticeType(notice.typeCode)) {
    warnings.push(`unknown-notice-type:${notice.typeCode}`);
  }

  const noticeLanguage = toLanguageCode(textAt(node, "NoticeLanguageCode"));
  const issuedAt = parseOffsetDateTime(
    textAt(node, "IssueDate"),
    textAt(node, "IssueTime"),
  );
  const requestedPublication = parseOffsetDateTime(
    textAt(node, "RequestedPublicationDate"),
  );

  const project = child(node, "ProcurementProject");
  const organizations = readOrganizations(node);
  const buyer = readBuyer(node, organizations);
  if (!buyer?.name) warnings.push("missing-buyer-name");

  const lots = readLots(node, noticeLanguage);
  const projectLocations = readLocations(project);
  const locations = dedupeAddresses([
    ...projectLocations,
    ...lots.flatMap((lot) => lot.locations),
  ]);

  const title = localized(textAt(project, "Name"), project, "Name", noticeLanguage);
  if (!title.original) warnings.push("missing-title");

  const description = localized(
    textAt(project, "Description"),
    project,
    "Description",
    noticeLanguage,
  );

  const cpvCodes = dedupe([
    ...readCpvCodes(project),
    ...lots.flatMap((lot) => lot.cpvCodes),
  ]);

  // The procedure is only closed once its last lot closes, so the aggregate
  // deadline is the latest lot deadline; per-lot deadlines stay on the lots.
  const lotDeadlines = lots
    .map((lot) => lot.submissionDeadline)
    .filter((value): value is Date => value !== null);
  const noticeLevelDeadline = readDeadline(child(node, "TenderingProcess"));

  const submissionDeadline =
    lotDeadlines.length > 0
      ? new Date(Math.max(...lotDeadlines.map((d) => d.getTime())))
      : noticeLevelDeadline.deadline;

  const deadlineKind: DeadlineKind =
    lotDeadlines.length > 0
      ? (lots.find((lot) => lot.submissionDeadline)?.deadlineKind ?? "TENDER")
      : noticeLevelDeadline.kind;

  if (notice.isPotentiallyBiddable && !submissionDeadline) {
    warnings.push("missing-submission-deadline");
  }

  const resultCodes = collectDescendants(node, "TenderResultCode").map((n) => text(n));
  const isAwarded =
    resultCodes.includes("selec-w") || notice.businessCategory === "AWARD_RESULT";
  const isCancelled = resultCodes.includes("clos-nw");

  const value =
    readMoney(path(project, "RequestedTenderTotal", "EstimatedOverallContractAmount")) ??
    readMoney(path(node, "NoticeResult", "TotalAmount")) ??
    firstLotValue(lots);

  const countries = dedupe([
    ...locations.map((location) => location.countryCode),
    buyer?.address?.countryCode ?? null,
  ]);
  const regions = dedupe([
    ...locations.map((location) => toRegionCode(location.nutsCode)),
    toRegionCode(buyer?.address?.nutsCode),
  ]);

  const publicationNumber = readPublicationNumber(node) ?? ref.publicationNumber;

  let validationStatus: ValidationStatus = warnings.length ? "VALID_WITH_WARNINGS" : "VALID";
  // A notice with neither title nor buyer is still stored — never dropped — but
  // it is flagged so the projection can keep it out of the opportunity UI (§13).
  if (!title.original && !buyer?.name) validationStatus = "VALID_WITH_WARNINGS";

  return {
    source: {
      code: raw.source,
      noticeId,
      versionId: textAt(node, "VersionID") ?? ref.sourceVersionId,
      versionKey: context.versionKey,
      publicationNumber,
      procedureId: textAt(node, "ContractFolderID") ?? ref.procedureId,
      url: context.discoveredUrl ?? raw.url,
      licence: raw.licence,
    },
    publication: {
      publishedAt: ref.publishedAt ?? requestedPublication ?? issuedAt,
      updatedAtSource: ref.updatedAtSource ?? issuedAt,
      languages: dedupe([noticeLanguage, ...readAdditionalLanguages(node)]),
    },
    notice,
    snapshot: {
      title,
      description,
      buyer,
      lots,
      cpvCodes,
      locations,
      countries,
      regions,
      value,
      submissionDeadline,
      deadlineKind,
      procedureType: text(child(child(node, "TenderingProcess"), "ProcedureCode")),
      contractNature: textAt(project, "ProcurementTypeCode"),
      documents: readDocuments(node),
      relatedNoticeIds: readRelatedNoticeIds(node),
      isCancelled,
      isAwarded,
    },
    processing: {
      parserVersion: EFORMS_PARSER_VERSION,
      schemaVersion: EFORMS_SCHEMA_VERSION,
      validationStatus,
      warnings,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Field readers                                                              */
/* -------------------------------------------------------------------------- */

function readNoticeId(node: XmlNode): string | null {
  const ids = children(node, "ID");
  return text(findBySchemeName(ids, "notice-id")) ?? text(ids[0]);
}

/** eForms carries the subtype in the notice-subtype extension field. */
function readSubtype(node: XmlNode): string | null {
  for (const candidate of collectDescendants(node, "SubTypeCode")) {
    const value = text(candidate);
    if (value) return value;
  }
  for (const candidate of collectDescendants(node, "NoticeSubType")) {
    const value = textAt(candidate, "SubTypeCode") ?? text(candidate);
    if (value) return value;
  }
  return null;
}

function readPublicationNumber(node: XmlNode): string | null {
  for (const candidate of collectDescendants(node, "NoticePublicationID")) {
    const value = text(candidate);
    if (value && !OJS_PLACEHOLDER.test(value)) return value;
  }
  return null;
}

function readAdditionalLanguages(node: XmlNode): Array<string | null> {
  const languages: Array<string | null> = [];
  for (const candidate of collectDescendants(node, "AdditionalNoticeLanguage")) {
    languages.push(toLanguageCode(textAt(candidate, "ID") ?? text(candidate)));
  }
  return languages;
}

interface OrganizationRecord {
  id: string | null;
  buyer: CanonicalBuyer;
}

function readOrganizations(node: XmlNode): OrganizationRecord[] {
  const records: OrganizationRecord[] = [];

  for (const organization of collectDescendants(node, "Organization")) {
    for (const company of children(organization, "Company")) {
      const identification = child(company, "PartyIdentification");
      const identifiers = children(identification, "ID");
      const id =
        text(findBySchemeName(identifiers, "organization")) ?? text(identifiers[0]);

      const address = readAddress(child(company, "PostalAddress"));
      const contact = child(company, "Contact");

      records.push({
        id,
        buyer: {
          name: textAt(child(company, "PartyName"), "Name"),
          identifiers: dedupe([
            id,
            textAt(child(company, "PartyLegalEntity"), "CompanyID"),
          ]),
          email: textAt(contact, "ElectronicMail"),
          phone: textAt(contact, "Telephone"),
          website: textAt(child(company, "WebsiteURI"), "#text") ?? textAt(company, "WebsiteURI"),
          legalType: null,
          activityType: null,
          address,
        },
      });
    }
  }
  return records;
}

/**
 * `ContractingParty` references the buyer by organization id; the details live in
 * the `efac:Organizations` extension. Resolving the reference matters because a
 * notice commonly also carries review bodies and service providers.
 */
function readBuyer(node: XmlNode, organizations: OrganizationRecord[]): CanonicalBuyer | null {
  const contractingParty = child(node, "ContractingParty");
  const partyIdentifiers = children(
    path(contractingParty, "Party", "PartyIdentification"),
    "ID",
  );
  const referencedId =
    text(findBySchemeName(partyIdentifiers, "organization")) ?? text(partyIdentifiers[0]);

  const matched =
    organizations.find((record) => record.id && record.id === referencedId) ??
    organizations[0];

  if (!matched) {
    const inlineName = textAt(path(contractingParty, "Party", "PartyName"), "Name");
    return inlineName
      ? {
          name: inlineName,
          identifiers: [],
          email: null,
          phone: null,
          website: null,
          legalType: text(path(contractingParty, "ContractingPartyType", "PartyTypeCode")),
          activityType: text(path(contractingParty, "ContractingActivity", "ActivityTypeCode")),
          address: null,
        }
      : null;
  }

  return {
    ...matched.buyer,
    legalType: text(path(contractingParty, "ContractingPartyType", "PartyTypeCode")),
    activityType: text(path(contractingParty, "ContractingActivity", "ActivityTypeCode")),
  };
}

function readAddress(addressNode: unknown): CanonicalAddress | null {
  if (!addressNode) return null;
  const nutsCode = text(child(addressNode, "CountrySubentityCode"));
  const countryCode = toCountryAlpha2(
    text(path(addressNode, "Country", "IdentificationCode")),
  );

  const address: CanonicalAddress = {
    streetName: textAt(addressNode, "StreetName"),
    city: textAt(addressNode, "CityName"),
    postalCode: textAt(addressNode, "PostalZone"),
    nutsCode,
    countryCode: countryCode ?? countryFromNuts(nutsCode),
  };

  const hasContent = Object.values(address).some((value) => value !== null);
  return hasContent ? address : null;
}

function readLocations(container: unknown): CanonicalAddress[] {
  const locations: CanonicalAddress[] = [];
  for (const realized of children(container, "RealizedLocation")) {
    const address = readAddress(child(realized, "Address"));
    if (address) locations.push(address);
  }
  return locations;
}

function readCpvCodes(container: unknown): string[] {
  const codes: string[] = [];
  const main = path(container, "MainCommodityClassification", "ItemClassificationCode");
  const mainCode = normalizeCpv(text(main));
  if (mainCode) codes.push(mainCode);

  for (const additional of children(container, "AdditionalCommodityClassification")) {
    const code = normalizeCpv(textAt(additional, "ItemClassificationCode"));
    if (code) codes.push(code);
  }
  return codes;
}

function readLots(node: XmlNode, noticeLanguage: string | null): CanonicalLot[] {
  const lots: CanonicalLot[] = [];

  for (const lot of children(node, "ProcurementProjectLot")) {
    const ids = children(lot, "ID");
    const lotId = text(findBySchemeName(ids, "Lot")) ?? text(ids[0]);
    if (!lotId) continue;

    const lotProject = child(lot, "ProcurementProject");
    const money = readMoney(
      path(lotProject, "RequestedTenderTotal", "EstimatedOverallContractAmount"),
    );

    const { deadline, kind } = readDeadline(child(lot, "TenderingProcess"));

    lots.push({
      lotId,
      title: textAt(lotProject, "Name"),
      description: textAt(lotProject, "Description"),
      cpvCodes: readCpvCodes(lotProject),
      estimatedValue: money,
      submissionDeadline: deadline,
      deadlineKind: kind,
      contractNature: textAt(lotProject, "ProcurementTypeCode"),
      locations: readLocations(lotProject),
    });
  }

  // A notice with no explicit lots still describes one procurement; the caller
  // relies on `lots` being empty in that case rather than synthesising a lot.
  void noticeLanguage;
  return lots;
}

/**
 * The legally binding closing date. Open procedures publish
 * `TenderSubmissionDeadlinePeriod`; restricted and negotiated procedures publish
 * only `ParticipationRequestReceptionPeriod`, and that is the real deadline for
 * them, so ignoring it would show a live opportunity as having none.
 */
function readDeadline(tenderingProcess: unknown): {
  deadline: Date | null;
  kind: DeadlineKind;
} {
  const tenderPeriod = child(tenderingProcess, "TenderSubmissionDeadlinePeriod");
  const tenderDeadline = parseOffsetDateTime(
    textAt(tenderPeriod, "EndDate"),
    textAt(tenderPeriod, "EndTime"),
  );
  if (tenderDeadline) return { deadline: tenderDeadline, kind: "TENDER" };

  const requestPeriod = child(tenderingProcess, "ParticipationRequestReceptionPeriod");
  const requestDeadline = parseOffsetDateTime(
    textAt(requestPeriod, "EndDate"),
    textAt(requestPeriod, "EndTime"),
  );
  if (requestDeadline) {
    return { deadline: requestDeadline, kind: "PARTICIPATION_REQUEST" };
  }

  return { deadline: null, kind: "NONE" };
}

function readMoney(amountNode: unknown): CanonicalMoney | null {
  const amount = parseAmount(text(amountNode));
  const currency = normalizeCurrency(attribute(amountNode, "currencyID"));
  if (amount === null && !currency) return null;
  return { amount, currency };
}

function firstLotValue(lots: CanonicalLot[]): CanonicalMoney | null {
  const withValue = lots.filter((lot) => lot.estimatedValue?.amount != null);
  if (!withValue.length) return null;

  const currency = withValue[0].estimatedValue!.currency;
  // Summing across currencies would invent a number, so a mixed-currency notice
  // reports no aggregate value and keeps the per-lot figures instead.
  if (withValue.some((lot) => lot.estimatedValue!.currency !== currency)) return null;

  return {
    amount: withValue.reduce((total, lot) => total + (lot.estimatedValue!.amount ?? 0), 0),
    currency,
  };
}

function readDocuments(node: XmlNode): CanonicalDocument[] {
  const documents: CanonicalDocument[] = [];
  const seen = new Set<string>();

  for (const kind of ["CallForTendersDocumentReference", "AdditionalDocumentReference"]) {
    for (const reference of collectDescendants(node, kind)) {
      const uri = text(path(reference, "Attachment", "ExternalReference", "URI"));
      if (!uri || seen.has(uri)) continue;
      seen.add(uri);

      const documentType = textAt(reference, "DocumentType");
      documents.push({
        url: uri,
        kind: documentType ?? kind,
        language: toLanguageCode(textAt(reference, "LanguageID")),
        restricted: documentType === "restricted-document",
      });
    }
  }
  return documents;
}

/**
 * Only strong official identifiers are collected. Section 8.2 allows automatic
 * linking on these alone; title or buyer similarity must never merge records.
 */
function readRelatedNoticeIds(node: XmlNode): Array<{ scheme: string; value: string }> {
  const related: Array<{ scheme: string; value: string }> = [];
  const seen = new Set<string>();

  const push = (scheme: string, value: string | null) => {
    if (!value || OJS_PLACEHOLDER.test(value)) return;
    const key = `${scheme}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    related.push({ scheme, value });
  };

  for (const element of collectDescendants(node, "ChangedNoticeIdentifier")) {
    push(attribute(element, "schemeName") ?? "changed-notice", text(element));
  }
  for (const element of collectDescendants(node, "ChangeNoticeVersionIdentifier")) {
    push("change-notice-version", text(element));
  }
  for (const element of collectDescendants(node, "ModifiedContractIdentifier")) {
    push("modified-contract", text(element));
  }
  for (const element of collectDescendants(node, "PreviousNoticeIdentifier")) {
    push(attribute(element, "schemeName") ?? "previous-notice", text(element));
  }
  for (const element of collectDescendants(node, "PreviousDocumentReference")) {
    push("previous-document", textAt(element, "ID"));
  }
  return related;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * eForms repeats a field once per language with a `languageID` attribute. The
 * notice language is treated as the original and the rest are kept as
 * translations, so no official wording is discarded.
 */
function localized(
  fallback: string | null,
  container: unknown,
  localName: string,
  noticeLanguage: string | null,
): LocalizedText {
  const translations: Record<string, string> = {};
  let original: string | null = null;
  let language: string | null = null;

  for (const element of children(container, localName)) {
    const value = text(element);
    if (!value) continue;
    const elementLanguage = toLanguageCode(attribute(element, "languageID"));

    if (!original && (!elementLanguage || elementLanguage === noticeLanguage)) {
      original = value;
      language = elementLanguage ?? noticeLanguage;
      continue;
    }
    if (elementLanguage) translations[elementLanguage] = value;
    else if (!original) original = value;
  }

  return {
    original: original ?? fallback,
    language: language ?? noticeLanguage,
    translations,
  };
}

function dedupe(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value) set.add(value);
  }
  return [...set];
}

function dedupeAddresses(addresses: CanonicalAddress[]): CanonicalAddress[] {
  const seen = new Set<string>();
  const unique: CanonicalAddress[] = [];
  for (const address of addresses) {
    const key = JSON.stringify(address);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(address);
  }
  return unique;
}
