import { Resend } from "resend";

import type { Locale } from "@/i18n/config";
import type { EmailDocument } from "./layout";
import {
  reportReadyEmail,
  type ReportReadyData,
} from "./report-ready-email";
import { resetPasswordEmail } from "./reset-password-email";
import { verificationEmail } from "./verification-email";

/**
 * The only place the product talks to Resend.
 *
 * Templates return `{ subject, text, html }` and know nothing about transport;
 * this module knows nothing about copy. Keeping the seam there is what lets a
 * template be rendered in a test or a preview route without an API key.
 */

function client(): { resend: Resend; from: string } {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!apiKey || !from) {
    throw new Error(
      "RESEND_API_KEY and EMAIL_FROM must be configured to send email.",
    );
  }

  return { resend: new Resend(apiKey), from };
}

async function send(to: string, message: EmailDocument) {
  const { resend, from } = client();
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

/** Resend's cap on one batch call. */
const BATCH_LIMIT = 100;

export interface ReportReadyRecipient {
  email: string;
  locale: Locale;
  data: ReportReadyData;
}

/**
 * Fans a finished report out to a whole company.
 *
 * Uses the batch endpoint rather than a loop of single sends: a ten-person
 * company would otherwise fire ten requests back to back and trip Resend's
 * per-second rate limit, turning a successful analysis into a partial
 * notification. `permissive` validation means one unroutable address costs that
 * one recipient rather than the entire batch.
 *
 * Returns the addresses that were rejected, so the caller can log them —
 * nothing here throws for a single bad recipient.
 */
export async function sendReportReadyEmails(
  recipients: ReportReadyRecipient[],
): Promise<{ sent: number; failed: string[] }> {
  if (recipients.length === 0) return { sent: 0, failed: [] };

  const { resend, from } = client();
  const failed: string[] = [];
  let sent = 0;

  for (let offset = 0; offset < recipients.length; offset += BATCH_LIMIT) {
    const chunk = recipients.slice(offset, offset + BATCH_LIMIT);
    const { data, error } = await resend.batch.send(
      chunk.map((recipient) => ({
        from,
        to: recipient.email,
        ...reportReadyEmail({
          locale: recipient.locale,
          data: recipient.data,
        }),
      })),
      { batchValidation: "permissive" as const },
    );

    if (error) throw new Error(error.message);

    for (const rejected of data?.errors ?? []) {
      const recipient = chunk[rejected.index];
      if (recipient) failed.push(recipient.email);
    }
    sent += chunk.length - (data?.errors?.length ?? 0);
  }

  return { sent, failed };
}
