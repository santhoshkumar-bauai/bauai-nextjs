import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";

import { OttoMount } from "@/components/otto/otto-mount";

import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "BAU AI | Construction intelligence",
    template: "%s | BAU AI",
  },
  description: "The AI platform for construction teams.",
  icons: { icon: "/brand/favicon.svg" },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const [locale, messages] = await Promise.all([getLocale(), getMessages()]);

  return (
    <html lang={locale} className="min-h-full scheme-light">
      <body className="min-h-full bg-[#f8f8f8] font-sans text-foreground">
        <NextIntlClientProvider messages={messages} locale={locale}>
          {children}
          {/*
            Mounted here, not per page: the root layout is preserved across
            client navigation, so the panel stays open and mid-conversation
            while Otto moves the user between routes. It renders nothing for
            signed-out visitors.
          */}
          <OttoMount />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
