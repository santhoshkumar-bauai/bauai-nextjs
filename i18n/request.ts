import { getRequestConfig } from "next-intl/server";
import { hasLocale } from "next-intl";
import { cookies, headers } from "next/headers";

import { defaultLocale, localeCookie, locales } from "./config";
import de from "@/messages/de.json";
import en from "@/messages/en.json";

const messages = { en, de } as const;

export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get(localeCookie)?.value;
  const browserLocale = (await headers())
    .get("accept-language")
    ?.split(",")[0]
    ?.trim()
    .split("-")[0];
  const requestedLocale = cookieLocale ?? browserLocale;
  const locale = hasLocale(locales, requestedLocale)
    ? requestedLocale
    : defaultLocale;

  return {
    locale,
    messages: messages[locale],
  };
});
