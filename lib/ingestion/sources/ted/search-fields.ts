/**
 * TED v3 Search API field selection.
 *
 * `fields` is mandatory and a single unsupported name fails the whole request, so
 * every name below was verified against the live API on 2026-08-05. `notice-title`
 * is deliberately excluded: it repeats the title in all 24 EU languages and would
 * multiply the stored raw payload for no gain over `title-proc` (§14).
 */
export const tedSearchFields = [
  // Identity and versioning.
  "publication-number",
  "notice-identifier",
  "notice-version",
  "notice-type",
  "notice-subtype",
  "form-type",
  "publication-date",
  "links",
  "legal-basis-notice",

  // Procedure.
  "procedure-identifier",
  "procedure-type",
  "contract-nature",
  "title-proc",
  "description-proc",

  // Classification.
  "classification-cpv",
  "main-classification-proc",
  "main-classification-lot",
  "additional-classification-lot",

  // Buyer.
  "buyer-name",
  "buyer-identifier",
  "buyer-country",
  "buyer-country-sub",
  "buyer-city",
  "buyer-post-code",
  "buyer-email",
  "buyer-internet-address",
  "buyer-legal-type",

  // Place of performance.
  "place-of-performance-country-proc",
  "place-of-performance-subdiv-proc",
  "place-of-performance-city-proc",
  "place-of-performance-post-code-proc",
  "place-of-performance-country-lot",
  "place-of-performance-subdiv-lot",
  "place-of-performance-city-lot",

  // Value.
  "estimated-value-proc",
  "estimated-value-cur-proc",
  "estimated-value-lot",
  "estimated-value-cur-lot",

  // Deadlines.
  "deadline-receipt-tender-date-lot",
  "deadline-receipt-tender-time-lot",
  "deadline-receipt-request-date-lot",
  "deadline-receipt-request-time-lot",

  // Lots.
  "title-lot",
  "description-lot",

  // Procurement document links. Verified 2026-08-05 that these come back from the
  // *anonymous* Search API, so TED document retrieval needs no API key — the earlier
  // assumption that document links exist only in the key-protected per-notice XML was
  // wrong. `document-restricted-lot` carries the same non-restricted/restricted flag
  // the German eForms parser reads, so §16's rule is applied identically for TED.
  "document-url-lot",
  "document-restricted-lot",

  // Relationships and results, used for safe cross-source linking (§8.2).
  "change-notice-version-identifier",
  "modification-previous-notice-identifier",
  "winner-name",
] as const;

/**
 * A TED field value is a scalar, an array, or a language map whose values are
 * themselves scalars or arrays. Callers must not assume a single shape.
 */
export type TedValue =
  | string
  | number
  | null
  | Array<string | number>
  | Record<string, string | number | Array<string | number>>;

export type TedSearchHit = Record<string, TedValue | TedLinks | undefined> & {
  "publication-number"?: string;
  "notice-identifier"?: string;
  "notice-version"?: number;
  "notice-type"?: string;
  "notice-subtype"?: string;
  "publication-date"?: string;
  links?: TedLinks;
};

export interface TedLinks {
  xml?: Record<string, string>;
  pdf?: Record<string, string>;
  html?: Record<string, string>;
  pdfs?: Record<string, string>;
}

export interface TedSearchResponse {
  notices?: TedSearchHit[];
  totalNoticeCount?: number;
  iterationNextToken?: string | null;
  timedOut?: boolean;
}
