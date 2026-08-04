import { localeCookie, locales, type Locale } from "@/i18n/config";

const isLocale = (value: string | undefined): value is Locale =>
  locales.includes(value as Locale);

export function resolveRequestLocale(request?: Request | null): Locale {
  const cookieHeader = request?.headers.get("cookie") ?? "";
  const selectedLocale = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim().split("="))
    .find(([name]) => name === localeCookie)?.[1];

  if (isLocale(selectedLocale)) return selectedLocale;

  const acceptedLocales = (request?.headers.get("accept-language") ?? "")
    .split(",")
    .map((language) => language.split(";")[0]?.trim().split("-")[0]);

  return acceptedLocales.find(isLocale) ?? "en";
}
