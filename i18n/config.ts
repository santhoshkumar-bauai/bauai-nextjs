export const locales = ["en", "de"] as const;
export const defaultLocale = "en";
export const localeCookie = "BAUAI_LOCALE";

export type Locale = (typeof locales)[number];
