/**
 * Price input parsing and money formatting for the BOQ editor. German
 * estimators type "1.234,56"; English input "1234.56" must work in the same
 * field. Pure functions — unit-tested next to this file.
 */

export function formatMoney(
  value: number | null | undefined,
  locale: string,
  currency: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** Unit prices keep up to 3 decimals (GAEB allows them). */
export function formatUnitPrice(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  }).format(value);
}

export function formatQty(value: number | null, locale: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  }).format(value);
}

/**
 * Parses a typed price accepting both decimal conventions.
 *
 * Rules, in order:
 * - both "." and "," present → the LAST separator is the decimal mark;
 * - only "," → decimal comma ("12,5" = 12.5);
 * - only "." → decimal point, EXCEPT the German-locale thousands idiom
 *   "1.234" (de locale, exactly three trailing digits) which reads as 1234;
 * - spaces and NBSP are grouping noise and ignored.
 *
 * Returns null for empty input; NaN sentinel is never returned — invalid
 * input yields undefined so callers can keep the previous value.
 */
export function parsePriceInput(raw: string, locale: string): number | null | undefined {
  const cleaned = raw.replace(/[\s  €]/g, "");
  if (cleaned === "") return null;
  if (!/^[-+]?[0-9.,]+$/.test(cleaned)) return undefined;

  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized =
      lastComma > lastDot
        ? cleaned.replace(/\./g, "").replace(",", ".")
        : cleaned.replace(/,/g, "");
  } else if (lastComma >= 0) {
    if (cleaned.indexOf(",") !== lastComma) return undefined;
    normalized = cleaned.replace(",", ".");
  } else if (lastDot >= 0) {
    const dots = cleaned.split(".").length - 1;
    const trailing = cleaned.length - lastDot - 1;
    if (dots > 1) {
      // "1.234.567" — grouping only, any locale.
      normalized = cleaned.replace(/\./g, "");
    } else if (locale === "de" && trailing === 3) {
      normalized = cleaned.replace(/\./g, "");
    } else {
      normalized = cleaned;
    }
  } else {
    normalized = cleaned;
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return undefined;
  // GAEB unit prices carry at most 3 decimals.
  return Math.round(value * 1000) / 1000;
}
