import type { Metadata } from "next";
import Image from "next/image";
import type { ReactNode } from "react";
import { CalendarDays, Headphones } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { LanguageSwitcher } from "@/components/language-switcher";

export const metadata: Metadata = {
  title: "Account",
};

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const t = await getTranslations("Auth");

  return (
    <main className="login-shell">
      <aside className="brand-panel" aria-label={t("introLabel")}>
        <Image
          src="/brand/login-bg.png"
          alt=""
          fill
          priority
          sizes="(max-width: 800px) 0px, 40vw"
          className="brand-background"
        />
        <div className="brand-overlay" />
        <div className="brand-content">
          <Image
            src="/brand/bau-ai-logo-white.svg"
            alt="BAU AI"
            width={156}
            height={34}
            priority
          />
          <section className="onboarding-card">
            <div className="onboarding-heading">
              <h2>{t("onboardingTitle")}</h2>
              <span aria-hidden="true">
                <CalendarDays size={19} />
                <span>+</span>
                <Headphones size={19} />
              </span>
            </div>
            <p>{t("onboardingDescription")}</p>
            <a
              href="https://outlook.office.com/book/SupportFeedback@bauai.eu/?ismsaljsauthenabled=true"
              target="_blank"
              rel="noreferrer"
            >
              {t("schedule")}
            </a>
          </section>
        </div>
      </aside>

      <section className="login-panel">
        <div className="login-toolbar"><LanguageSwitcher /></div>
        {children}
        <p className="tagline">{t("tagline")}</p>
      </section>
    </main>
  );
}
