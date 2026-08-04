import type { Metadata } from "next";
import Image from "next/image";
import type { ReactNode } from "react";
import { CalendarDays, Headphones } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { LanguageSwitcher } from "@/components/language-switcher";

export const metadata: Metadata = {
  title: "Account",
};

export default async function AuthLayout({
  children,
}: {
  children: ReactNode;
}) {
  const t = await getTranslations("Auth");

  return (
    <main className="grid min-h-svh grid-cols-[minmax(360px,38%)_1fr] max-[800px]:block">
      <aside
        className="relative min-h-svh overflow-hidden text-white max-[800px]:hidden"
        aria-label={t("introLabel")}
      >
        <Image
          src="/brand/login-bg.png"
          alt=""
          fill
          priority
          sizes="(max-width: 800px) 0px, 40vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-[rgba(69,12,129,.78)] backdrop-blur-[6px]" />
        <div className="relative z-1 grid w-[min(100%,490px)] gap-[92px] px-[clamp(28px,5vw,64px)] py-[54px]">
          <Image
            src="/brand/bau-ai-logo-white.svg"
            alt="BAU AI"
            width={156}
            height={34}
            priority
          />
          <section className="rounded-2xl border border-white/25 bg-white/12 p-[30px] shadow-[0_20px_48px_rgba(18,0,40,.14)] backdrop-blur-[17px]">
            <div className="flex items-center justify-between gap-2.5">
              <h2 className="m-0 text-base font-semibold">
                {t("onboardingTitle")}
              </h2>
              <span
                className="flex items-center justify-between gap-2.5 text-white/75"
                aria-hidden="true"
              >
                <CalendarDays size={19} />
                <span className="text-sm">+</span>
                <Headphones size={19} />
              </span>
            </div>
            <p className="my-[21px] mb-[25px] text-sm leading-[1.6]">
              {t("onboardingDescription")}
            </p>
            <a
              className="grid min-h-[45px] place-items-center rounded-[9px] border border-white/30 bg-white/18 text-sm font-semibold no-underline transition-colors hover:bg-white/28"
              href="https://outlook.office.com/book/SupportFeedback@bauai.eu/?ismsaljsauthenabled=true"
              target="_blank"
              rel="noreferrer"
            >
              {t("schedule")}
            </a>
          </section>
        </div>
      </aside>

      <section className="relative grid min-h-svh place-items-center bg-[#fbfaf9] px-7 pt-[88px] pb-[70px] max-[800px]:px-5 max-[800px]:pt-[92px]">
        <div className="absolute top-[30px] right-10 max-[800px]:top-6 max-[800px]:right-6">
          <LanguageSwitcher />
        </div>
        {children}
        <p className="absolute bottom-[27px] m-0 max-w-[520px] px-6 text-center text-xs leading-normal text-[#807b89]">
          {t("tagline")}
        </p>
      </section>
    </main>
  );
}
