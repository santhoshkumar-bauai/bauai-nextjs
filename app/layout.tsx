import type { Metadata } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";

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
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
