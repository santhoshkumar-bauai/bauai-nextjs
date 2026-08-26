"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";

/**
 * One AI failure code → one user-visible sentence.
 *
 * Every chat surface used to render a binary `code === "rate_limited" ? … : …`,
 * which meant a blocked prompt, an expired credential and a runaway tool loop
 * all read as "Something went wrong. Try again." — advice that is wrong for all
 * three. Codes come from `lib/ai/agent/errors.ts` and the catalog carries a
 * string per code, so adding a code needs no component change.
 *
 * MUST stay referentially stable. This returns a function, and callers put that
 * function into `useCallback`/`useEffect` dependency arrays — a fresh closure
 * per render makes every one of those deps change on every render. That is not
 * theoretical: it put the report page into an infinite fetch loop
 * (`useAiErrorMessage` → `errorMessage` → `apply` → the load effect → setState
 * → re-render), which aborted and re-issued the same request hundreds of times
 * and stopped the page rendering at all. `t` is memoized per namespace by
 * next-intl, so this only recomputes when the locale or the catalog changes.
 */
export function useAiErrorMessage(): (code: string | null | undefined) => string {
  const t = useTranslations("AiErrors");
  return useCallback(
    (code: string | null | undefined) => {
      if (!code) return t("failed");
      // `has` keeps an unrecognised code (an older client, a surface-specific
      // token like "empty_stream") from throwing inside a render.
      return t.has(code) ? t(code) : t("failed");
    },
    [t],
  );
}
