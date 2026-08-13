import { Resend } from "resend";

import type { Locale } from "@/i18n/config";
import { resetPasswordEmail } from "./reset-password-email";
import { verificationEmail } from "./verification-email";

type Message = { subject: string; text: string; html: string };

async function send(to: string, message: Message) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error(
      "RESEND_API_KEY and EMAIL_FROM must be configured to send email.",
    );
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({ from, to, ...message });

  if (error) throw new Error(error.message);
}

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
  await send(to, verificationEmail({ locale, name, verificationUrl }));
}

export async function sendResetPasswordEmail({
  to,
  name,
  resetUrl,
  locale,
}: {
  to: string;
  name: string;
  resetUrl: string;
  locale: Locale;
}) {
  await send(to, resetPasswordEmail({ locale, name, resetUrl }));
}
