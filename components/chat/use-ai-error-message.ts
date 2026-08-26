"use client";

import { useTranslations } from "next-intl";

/**
 * One AI failure code → one user-visible sentence.
 *
 * Every chat surface used to render a binary `code === "rate_limited" ? … : …`,
 * which meant a blocked prompt, an expired credential and a runaway tool loop
 * all read as "Something went wrong. Try again." — advice that is wrong for all
 * three. Codes come from `lib/ai/agent/errors.ts` and the catalog carries a
 * string per code, so adding a code needs no component change.
 */
export function useAiErrorMessage(): (code: string | null | undefined) => string {
  const t = useTranslations("AiErrors");
  return (code) => {
    if (!code) return t("failed");
    // `has` keeps an unrecognised code (an older client, a surface-specific
    // token like "empty_stream") from throwing inside a render.
    return t.has(code) ? t(code) : t("failed");
  };
}
