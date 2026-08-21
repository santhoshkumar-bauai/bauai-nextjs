import type { Locale } from "@/i18n/config";

import {
  button,
  paragraph,
  rawLink,
  renderEmail,
  renderText,
  type EmailDocument,
} from "./layout";

/**
 * Password reset.
 *
 * Deliberately the plainest email we send: no demo card, no product pitch. A
 * reset that arrives unrequested is a security signal, and the reader needs the
 * "you can ignore this" line to be the most prominent thing after the button —
 * not competing with marketing.
 */

const copy = {
  en: {
    subject: "Reset your BAU AI password",
    preheader: "Use the link inside to choose a new password. It expires in one hour.",
    eyebrow: "Password reset",
    title: "Choose a new password",
    greeting: (name: string) => `Hi ${name},`,
    body: "We received a request to reset the password for your BAU AI account. Choose a new one to get back into your workspace.",
    button: "Reset password",
    fallback: "Button not working? Copy this link into your browser:",
    expiry:
      "This link expires in one hour and can be used once. If you did not request a reset, you can safely ignore this email — your password stays unchanged and no one has access to your account.",
    footerNote:
      "You are receiving this email because a password reset was requested for this address.",
  },
  de: {
    subject: "Setzen Sie Ihr BAU AI Passwort zurück",
    preheader:
      "Über den Link im Inneren wählen Sie ein neues Passwort. Gültig für eine Stunde.",
    eyebrow: "Passwort zurücksetzen",
    title: "Neues Passwort wählen",
    greeting: (name: string) => `Hallo ${name},`,
    body: "Wir haben eine Anfrage erhalten, das Passwort für Ihr BAU AI Konto zurückzusetzen. Wählen Sie ein neues Passwort, um wieder auf Ihren Workspace zuzugreifen.",
    button: "Passwort zurücksetzen",
    fallback:
      "Button funktioniert nicht? Kopieren Sie diesen Link in Ihren Browser:",
    expiry:
      "Dieser Link läuft in einer Stunde ab und kann nur einmal verwendet werden. Falls Sie kein neues Passwort angefordert haben, können Sie diese E-Mail ignorieren — Ihr Passwort bleibt unverändert und niemand hat Zugriff auf Ihr Konto.",
    footerNote:
      "Sie erhalten diese E-Mail, weil für diese Adresse ein Passwort-Reset angefordert wurde.",
  },
} as const;

export function resetPasswordEmail({
  locale,
  name,
  resetUrl,
}: {
  locale: Locale;
  name: string;
  resetUrl: string;
}): EmailDocument {
  const message = copy[locale];

  const content = [
    paragraph(message.greeting(name), { tone: "ink", spaceAfter: 12 }),
    paragraph(message.body, { spaceAfter: 28 }),
    button({ href: resetUrl, label: message.button }),
    rawLink(message.fallback, resetUrl),
    paragraph(message.expiry, { tone: "muted", spaceAfter: 0 }),
  ].join("");

  return {
    subject: message.subject,
    html: renderEmail({
      locale,
      preheader: message.preheader,
      eyebrow: message.eyebrow,
      title: message.title,
      content,
      footerNote: message.footerNote,
      // A security email that also sells a demo undermines its own advice.
      booking: "none",
    }),
    text: renderText({
      locale,
      title: message.title,
      booking: "none",
      lines: [
        message.greeting(name),
        "",
        message.body,
        "",
        `${message.button}: ${resetUrl}`,
        "",
        message.expiry,
      ],
    }),
  };
}
