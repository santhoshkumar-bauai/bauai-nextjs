"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

import { localeCookie, locales, type Locale } from "@/i18n/config";

const labels = { en: "EN", de: "DE" };

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("Language");
  const router = useRouter();

  function changeLocale(nextLocale: Locale) {
    document.cookie = `${localeCookie}=${nextLocale};path=/;max-age=31536000;samesite=lax`;
    router.refresh();
  }

  return (
    <label className="inline-flex items-center gap-2 text-sm text-[#555163]">
      <Languages aria-hidden="true" size={17} strokeWidth={2} />
      <span className="sr-only">{t("select")}</span>
      <select
        className="cursor-pointer appearance-none border-0 bg-transparent py-1.5 pr-5 font-semibold text-inherit outline-none"
        aria-label={t("select")}
        value={locale}
        onChange={(event) => changeLocale(event.target.value as Locale)}
      >
        {locales.map((item) => (
          <option key={item} value={item}>
            {labels[item]}
          </option>
        ))}
      </select>
    </label>
  );
}
