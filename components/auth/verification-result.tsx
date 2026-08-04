"use client";

import { useEffect } from "react";
import { Check, CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";

export function VerificationResult({ error }: { error?: string }) {
  const t = useTranslations("VerifyEmail");
  const router = useRouter();

  useEffect(() => {
    if (error) return;
    const timer = window.setTimeout(() => router.replace("/onboarding"), 2200);
    return () => window.clearTimeout(timer);
  }, [error, router]);

  return (
    <section className="login-card verification-card" aria-live="polite">
      <div className={error ? "verification-badge is-error" : "verification-badge"}>
        <span>{error ? <CircleAlert size={34} /> : <Check size={38} strokeWidth={3} />}</span>
      </div>
      <h1>{error ? t("errorTitle") : t("successTitle")}</h1>
      <p>{error ? t("errorDescription") : t("successDescription")}</p>
      {!error && <div className="redirect-progress" aria-hidden="true"><span /></div>}
      <a className="status-link" href={error ? "/sign-up" : "/onboarding"}>{error ? t("tryAgain") : t("continue")}</a>
    </section>
  );
}
