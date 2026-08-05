import { missingIdentity } from "../../http/errors.ts";
import {
  normalizeCpv,
  normalizeCurrency,
  parseAmount,
  toCountryAlpha2,
  toLanguageCode,
  toRegionCode,
} from "../../eforms/codelists.ts";
import { classifyNoticeType, isKnownNoticeType } from "../../eforms/notice-types.ts";
import type {
  CanonicalAddress,
  CanonicalDocument,
  CanonicalLot,
  DeadlineKind,
  DiscoveredNotice,
  LocalizedText,
  RawNotice,
  SourceNotice,
  ValidationStatus,
} from "../../types.ts";
import { parseOffsetDateTime } from "../../utils/time.ts";
import type { TedLinks, TedSearchHit, TedValue } from "./search-fields.ts";

export const TED_SEARCH_PARSER_VERSION = "ted-search-1.0.0";
export const TED_SEARCH_SCHEMA_VERSION = 1;

/**
 * Normalizes a TED Search API hit into the canonical model.
 *
 * The public Search API needs no credentials, while per-notice XML requires an
 * API key, so this is the default path for TED. It carries fewer fields than the
 * eForms XML — notably no structured documents — which is recorded as a data
 * quality warning rather than hidden.
 */
export function parseTedSearchHit(
  raw: RawNotice,
  ref: DiscoveredNotice,
  context: { versionKey: string; licence: string },
): SourceNotice {
  let hit: TedSearchHit;
  try {
    hit = JSON.parse(raw.body.toString("utf8")) as TedSearchHit;
  } catch (error) {
    throw missingIdentity(`TED search hit for ${raw.sourceNoticeId} is not valid JSON: ${String(error)}`);
  }

  const noticeId = str(hit["notice-identifier"]) ?? ref.sourceNoticeId;
  const publicationNumber = str(hit["publication-number"]) ?? ref.publicationNumber;
  if (!noticeId && !publicationNumber) {
    throw missingIdentity("TED search hit has neither a notice identifier nor a publication number");
  }

  const warnings: string[] = ["ted-search-projection"];

  const notice = classifyNoticeType(
    str(hit["notice-type"]),
    str(hit["notice-subtype"]),
    str(hit["form-type"]),
  );
  if (!isKnownNoticeType(notice.typeCode)) {
    warnings.push(`unknown-notice-type:${notice.typeCode}`);
  }

  const publishedAt = parseOffsetDateTime(str(hit["publication-date"]));
  const title = localized(hit["title-proc"]);
  if (!title.original) warnings.push("missing-title");

  const buyerCountries = list(hit["buyer-country"])
    .map((value) => toCountryAlpha2(value))
    .filter((value): value is string => value !== null);
  const buyerSubdivisions = list(hit["buyer-country-sub"]);

  const buyerName = localized(hit["buyer-name"]).original;
  if (!buyerName) warnings.push("missing-buyer-name");

  const buyerAddress: CanonicalAddress | null =
    buyerCountries.length || buyerSubdivisions.length
      ? {
          streetName: null,
          city: localized(hit["buyer-city"]).original,
          postalCode: list(hit["buyer-post-code"])[0] ?? null,
          nutsCode: buyerSubdivisions[0] ?? null,
          countryCode: buyerCountries[0] ?? null,
        }
      : null;

  const lots = readLots(hit);
  const locations = readLocations(hit);

  const lotDeadlines = lots
    .map((lot) => lot.submissionDeadline)
    .filter((value): value is Date => value !== null);
  const submissionDeadline = lotDeadlines.length
    ? new Date(Math.max(...lotDeadlines.map((date) => date.getTime())))
    : null;
  const deadlineKind: DeadlineKind = lotDeadlines.length
    ? (lots.find((lot) => lot.submissionDeadline)?.deadlineKind ?? "TENDER")
    : "NONE";

  if (notice.isPotentiallyBiddable && !submissionDeadline) {
    warnings.push("missing-submission-deadline");
  }

  const cpvCodes = unique([
    ...list(hit["main-classification-proc"]),
    ...list(hit["main-classification-lot"]),
    ...list(hit["additional-classification-lot"]),
    ...list(hit["classification-cpv"]),
  ].map(normalizeCpv));

  const amount = parseAmount(str(hit["estimated-value-proc"]));
  const currency = normalizeCurrency(str(hit["estimated-value-cur-proc"]));
  const value =
    amount !== null || currency
      ? { amount, currency }
      : sumLotValues(lots);

  const isAwarded =
    notice.businessCategory === "AWARD_RESULT" ||
    localized(hit["winner-name"]).original !== null;

  const countries = unique([
    ...locations.map((location) => location.countryCode),
    ...buyerCountries,
  ]);
  const regions = unique([
    ...locations.map((location) => toRegionCode(location.nutsCode)),
    ...buyerSubdivisions.map(toRegionCode),
  ]);

  const validationStatus: ValidationStatus = "VALID_WITH_WARNINGS";

  return {
    source: {
      code: "TED",
      noticeId: noticeId ?? publicationNumber!,
      versionId: hit["notice-version"] != null ? String(hit["notice-version"]) : null,
      versionKey: context.versionKey,
      publicationNumber: publicationNumber ?? null,
      procedureId: str(hit["procedure-identifier"]) ?? ref.procedureId,
      url: ref.url ?? xmlLink(hit.links) ?? null,
      licence: context.licence,
    },
    publication: {
      publishedAt: publishedAt ?? ref.publishedAt,
      updatedAtSource: publishedAt ?? ref.updatedAtSource,
      languages: unique(languagesOf(hit["title-proc"]).map(toLanguageCode)),
    },
    notice,
    snapshot: {
      title,
      description: localized(hit["description-proc"]),
      buyer: buyerName || buyerAddress
        ? {
            name: buyerName,
            identifiers: list(hit["buyer-identifier"]),
            email: list(hit["buyer-email"])[0] ?? null,
            phone: null,
            website: list(hit["buyer-internet-address"])[0] ?? null,
            legalType: list(hit["buyer-legal-type"])[0] ?? null,
            activityType: null,
            address: buyerAddress,
          }
        : null,
      lots,
      cpvCodes,
      locations,
      countries,
      regions,
      value,
      submissionDeadline,
      deadlineKind,
      procedureType: str(hit["procedure-type"]),
      contractNature: list(hit["contract-nature"])[0] ?? null,
      documents: readDocuments(hit),
      relatedNoticeIds: readRelatedNoticeIds(hit),
      isCancelled: false,
      isAwarded,
    },
    processing: {
      parserVersion: TED_SEARCH_PARSER_VERSION,
      schemaVersion: TED_SEARCH_SCHEMA_VERSION,
      validationStatus,
      warnings,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Value shape helpers                                                        */
/* -------------------------------------------------------------------------- */

/** First scalar in a TED value, looking through arrays and language maps. */
function str(value: TedValue | TedLinks | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return str(value[0] as TedValue);
  const entries = Object.values(value as Record<string, TedValue>);
  return entries.length ? str(entries[0]) : null;
}

/** Every scalar in a TED value, flattened. */
function list(value: TedValue | TedLinks | undefined): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap((entry) => list(entry as TedValue));
  return Object.values(value as Record<string, TedValue>).flatMap((entry) => list(entry));
}

/**
 * Language maps use ISO 639-2 keys (`slv`, `deu`, `mul`). `mul` marks
 * multilingual content and is treated as the original when present.
 */
function localized(value: TedValue | TedLinks | undefined): LocalizedText {
  if (value === null || value === undefined) {
    return { original: null, language: null, translations: {} };
  }
  if (typeof value === "string" || typeof value === "number" || Array.isArray(value)) {
    return { original: str(value), language: null, translations: {} };
  }

  const map = value as Record<string, TedValue>;
  const translations: Record<string, string> = {};
  let original: string | null = null;
  let language: string | null = null;

  for (const [rawLanguage, entry] of Object.entries(map)) {
    const text = str(entry);
    if (!text) continue;
    const code = toLanguageCode(rawLanguage);
    if (!original || rawLanguage.toLowerCase() === "mul") {
      if (original && language) translations[language] = original;
      original = text;
      language = code;
      continue;
    }
    if (code) translations[code] = text;
  }

  return { original, language, translations };
}

function languagesOf(value: TedValue | TedLinks | undefined): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>);
}

function xmlLink(links: TedLinks | undefined): string | null {
  if (!links?.xml) return null;
  return links.xml.MUL ?? Object.values(links.xml)[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Structure readers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The Search API returns lot data as parallel arrays rather than nested objects,
 * so lots are reconstructed by index. Arrays of differing length are common, and
 * a missing entry is left null instead of shifting later lots out of alignment.
 */
function readLots(hit: TedSearchHit): CanonicalLot[] {
  const titles = list(hit["title-lot"]);
  const descriptions = list(hit["description-lot"]);
  const values = list(hit["estimated-value-lot"]);
  const currencies = list(hit["estimated-value-cur-lot"]);
  const mainCpv = list(hit["main-classification-lot"]);
  const tenderDates = list(hit["deadline-receipt-tender-date-lot"]);
  const tenderTimes = list(hit["deadline-receipt-tender-time-lot"]);
  const requestDates = list(hit["deadline-receipt-request-date-lot"]);
  const requestTimes = list(hit["deadline-receipt-request-time-lot"]);

  const count = Math.max(
    titles.length,
    descriptions.length,
    values.length,
    mainCpv.length,
    tenderDates.length,
    requestDates.length,
  );
  if (count === 0) return [];

  const lots: CanonicalLot[] = [];
  for (let index = 0; index < count; index += 1) {
    const tenderDeadline = parseOffsetDateTime(tenderDates[index], tenderTimes[index]);
    const requestDeadline = parseOffsetDateTime(requestDates[index], requestTimes[index]);
    const amount = parseAmount(values[index]);
    const currency = normalizeCurrency(currencies[index] ?? currencies[0]);

    lots.push({
      lotId: `LOT-${String(index + 1).padStart(4, "0")}`,
      title: titles[index] ?? null,
      description: descriptions[index] ?? null,
      cpvCodes: unique([normalizeCpv(mainCpv[index])]),
      estimatedValue: amount !== null || currency ? { amount, currency } : null,
      submissionDeadline: tenderDeadline ?? requestDeadline,
      deadlineKind: tenderDeadline
        ? "TENDER"
        : requestDeadline
          ? "PARTICIPATION_REQUEST"
          : "NONE",
      contractNature: list(hit["contract-nature"])[index] ?? null,
      locations: [],
    });
  }
  return lots;
}

function readLocations(hit: TedSearchHit): CanonicalAddress[] {
  const countries = [
    ...list(hit["place-of-performance-country-proc"]),
    ...list(hit["place-of-performance-country-lot"]),
  ];
  const subdivisions = [
    ...list(hit["place-of-performance-subdiv-proc"]),
    ...list(hit["place-of-performance-subdiv-lot"]),
  ];
  const cities = [
    ...list(hit["place-of-performance-city-proc"]),
    ...list(hit["place-of-performance-city-lot"]),
  ];
  const postCodes = list(hit["place-of-performance-post-code-proc"]);

  const count = Math.max(countries.length, subdivisions.length, cities.length);
  const seen = new Set<string>();
  const locations: CanonicalAddress[] = [];

  for (let index = 0; index < count; index += 1) {
    const nutsCode = subdivisions[index] ?? null;
    const address: CanonicalAddress = {
      streetName: null,
      city: cities[index] ?? null,
      postalCode: postCodes[index] ?? null,
      nutsCode,
      countryCode: toCountryAlpha2(countries[index]) ?? toCountryAlpha2(nutsCode?.slice(0, 2)),
    };
    const key = JSON.stringify(address);
    if (seen.has(key)) continue;
    seen.add(key);
    locations.push(address);
  }
  return locations;
}

/**
 * Procurement document links from `document-url-lot`.
 *
 * The restriction flags arrive as a parallel array, so they are matched by index and
 * fall back to the first value when the arrays differ in length — a notice commonly
 * states one restriction for several lot documents. Anything the source marks
 * restricted is preserved with the flag set and is never fetched (§16).
 */
function readDocuments(hit: TedSearchHit): CanonicalDocument[] {
  const urls = unique(list(hit["document-url-lot"]));
  if (!urls.length) return [];

  const restrictions = list(hit["document-restricted-lot"]);

  return urls.map((url, index) => {
    const flag = restrictions[index] ?? restrictions[0] ?? null;
    return {
      url,
      kind: flag,
      language: null,
      restricted: flag === "restricted-document",
    };
  });
}

function readRelatedNoticeIds(hit: TedSearchHit): Array<{ scheme: string; value: string }> {
  const related: Array<{ scheme: string; value: string }> = [];
  const seen = new Set<string>();

  const push = (scheme: string, value: string) => {
    const key = `${scheme}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    related.push({ scheme, value });
  };

  for (const value of list(hit["change-notice-version-identifier"])) {
    push("change-notice-version", value);
  }
  for (const value of list(hit["modification-previous-notice-identifier"])) {
    push("previous-notice", value);
  }
  return related;
}

function sumLotValues(lots: CanonicalLot[]) {
  const withValue = lots.filter((lot) => lot.estimatedValue?.amount != null);
  if (!withValue.length) return null;
  const currency = withValue[0].estimatedValue!.currency;
  if (withValue.some((lot) => lot.estimatedValue!.currency !== currency)) return null;
  return {
    amount: withValue.reduce((total, lot) => total + (lot.estimatedValue!.amount ?? 0), 0),
    currency,
  };
}

function unique(values: Array<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (value) set.add(value);
  }
  return [...set];
}
