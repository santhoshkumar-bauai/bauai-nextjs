import { Resend } from "resend";

import type { Locale } from "@/i18n/config";
import { verificationEmail } from "./verification-email";

export async function sendVerificationEmail({
  to,
  name,
  verificationUrl,
  locale,
}: {
  to: string;
  name: string;
  verificationUrl: string;
  locale: Locale;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error("RESEND_API_KEY and EMAIL_FROM must be configured to send email.");
  }

  const resend = new Resend(apiKey);
  const message = verificationEmail({ locale, name, verificationUrl });
  const { error } = await resend.emails.send({ from, to, ...message });

  if (error) throw new Error(error.message);
}
