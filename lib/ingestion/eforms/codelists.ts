/**
 * Static official codelist mappings, cached in module scope per section 14.
 *
 * eForms uses ISO 3166-1 alpha-3 for countries and ISO 639-2/B for languages,
 * while the application filters on alpha-2 and BCP-47 style short codes.
 */
const countryAlpha3ToAlpha2: Record<string, string> = {
  AUT: "AT", BEL: "BE", BGR: "BG", CYP: "CY", CZE: "CZ", DEU: "DE", DNK: "DK",
  EST: "EE", ESP: "ES", FIN: "FI", FRA: "FR", GRC: "GR", HRV: "HR", HUN: "HU",
  IRL: "IE", ITA: "IT", LTU: "LT", LUX: "LU", LVA: "LV", MLT: "MT", NLD: "NL",
  POL: "PL", PRT: "PT", ROU: "RO", SWE: "SE", SVN: "SI", SVK: "SK",
  ISL: "IS", LIE: "LI", NOR: "NO", CHE: "CH", GBR: "GB", ALB: "AL", BIH: "BA",
  MKD: "MK", MNE: "ME", SRB: "RS", TUR: "TR", UKR: "UA", MDA: "MD", GEO: "GE",
  USA: "US", CAN: "CA", AUS: "AU", NZL: "NZ", JPN: "JP", KOR: "KR", CHN: "CN",
  IND: "IN", BRA: "BR", MEX: "MX", ZAF: "ZA", ISR: "IL", ARE: "AE", SAU: "SA",
  XKX: "XK", MCO: "MC", SMR: "SM", AND: "AD", VAT: "VA",
};

const languageAlpha3ToAlpha2: Record<string, string> = {
  BUL: "bg", CES: "cs", DAN: "da", DEU: "de", ELL: "el", ENG: "en", EST: "et",
  FIN: "fi", FRA: "fr", GLE: "ga", HRV: "hr", HUN: "hu", ITA: "it", LAV: "lv",
  LIT: "lt", MLT: "mt", NLD: "nl", POL: "pl", POR: "pt", RON: "ro", SLK: "sk",
  SLV: "sl", SPA: "es", SWE: "sv", NOR: "no", ISL: "is", TUR: "tr", UKR: "uk",
  SRP: "sr", BOS: "bs", MKD: "mk", ALB: "sq", SQI: "sq", MUL: "mul",
};

export function toCountryAlpha2(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  if (upper.length === 2) return upper;
  return countryAlpha3ToAlpha2[upper] ?? null;
}

export function toLanguageCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  if (trimmed.length === 2) return trimmed.toLowerCase();
  return languageAlpha3ToAlpha2[trimmed.toUpperCase()] ?? trimmed.toLowerCase();
}

/** The country a NUTS code belongs to; the first two characters are ISO alpha-2. */
export function countryFromNuts(nuts: string | null | undefined): string | null {
  if (!nuts) return null;
  const upper = nuts.trim().toUpperCase();
  return /^[A-Z]{2}/.test(upper) ? upper.slice(0, 2) : null;
}

/**
 * Regional grouping used by `tenders.regions`. NUTS 2 is the level that matches
 * how buyers describe a region, so deeper codes are truncated to it.
 */
export function toRegionCode(nuts: string | null | undefined): string | null {
  if (!nuts) return null;
  const upper = nuts.trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{1,3}$/.test(upper)) return null;
  return upper.length > 4 ? upper.slice(0, 4) : upper;
}

/** CPV codes appear with and without the check digit; the app keys on 8 digits. */
export function normalizeCpv(code: string | null | undefined): string | null {
  if (!code) return null;
  const digits = code.trim().replace(/[^0-9]/g, "");
  if (digits.length < 8) return null;
  return digits.slice(0, 8);
}

const currencyPattern = /^[A-Z]{3}$/;

export function normalizeCurrency(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return currencyPattern.test(upper) ? upper : null;
}

export function parseAmount(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value.replace(/\s/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}
