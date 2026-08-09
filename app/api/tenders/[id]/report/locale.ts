import { resolveRequestLocale } from "@/lib/i18n/request-locale";
import { REPORT_LOCALES, type ReportLocale } from "@/lib/ai/report/schema";

/**
 * The language a report request is about.
 *
 * An explicit `?locale=` wins over the cookie so the page can ask for exactly
 * the language it is rendering — the locale cookie is set client-side and a
 * just-switched language would otherwise lag a request behind.
 */
export function reportLocaleFromRequest(request: Request): ReportLocale {
  const requested = new URL(request.url).searchParams.get("locale");
  if ((REPORT_LOCALES as readonly string[]).includes(requested ?? "")) {
    return requested as ReportLocale;
  }
  return resolveRequestLocale(request) as ReportLocale;
}
