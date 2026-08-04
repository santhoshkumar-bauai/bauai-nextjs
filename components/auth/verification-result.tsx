"use client";

import { useEffect } from "react";
import { Check, CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { authCard, authStatus } from "./auth-tailwind";

export function VerificationResult({ error }: { error?: string }) {
  const t = useTranslations("VerifyEmail");
  const router = useRouter();

  useEffect(() => {
    if (error) return;
    const timer = window.setTimeout(() => router.replace("/onboarding"), 2200);
    return () => window.clearTimeout(timer);
  }, [error, router]);

  return (
    <section className={`${authCard} ${authStatus}`} aria-live="polite">
      <div
        className={`relative mx-auto grid size-[84px] place-items-center rounded-full ${error ? "bg-red-50 text-[#c23737]" : "bg-[#eafaf0] text-[#18864b] before:absolute before:-inset-2 before:animate-success-pulse before:rounded-[inherit] before:border-2 before:border-[rgba(24,134,75,.2)] before:content-[''] after:absolute after:-inset-2 after:animate-success-pulse after:rounded-[inherit] after:border-2 after:border-[rgba(24,134,75,.2)] after:[animation-delay:.55s] after:content-['']"}`}
      >
        <span>
          {error ? (
            <CircleAlert size={34} />
          ) : (
            <Check size={38} strokeWidth={3} />
          )}
        </span>
      </div>
      <h1>{error ? t("errorTitle") : t("successTitle")}</h1>
      <p>{error ? t("errorDescription") : t("successDescription")}</p>
      {!error && (
        <div
          className="mx-auto mt-6 h-1 w-[170px] overflow-hidden rounded-full bg-[#eee8f2]"
          aria-hidden="true"
        >
          <span className="block h-full w-full origin-left animate-redirect-progress bg-[#6515b7]" />
        </div>
      )}
      <a
        className="mt-6 inline-block text-[13px] font-bold text-[#5000a8] no-underline"
        href={error ? "/sign-up" : "/onboarding"}
      >
        {error ? t("tryAgain") : t("continue")}
      </a>
    </section>
  );
}
