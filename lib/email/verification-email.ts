import type { Locale } from "@/i18n/config";

import { bookingUrl } from "./brand";
import {
  button,
  divider,
  outlinePanel,
  panelHeading,
  paragraph,
  rawLink,
  renderEmail,
  renderText,
  type EmailDocument,
} from "./layout";

/**
 * The first email a new account ever receives, and the only one standing
 * between signup and the product.
 *
 * It carries a second call to action the other transactional mails do not: the
 * onboarding demo booking. Verification is the moment intent is highest, and a
 * self-serve account that never gets shown the product is the one that churns —
 * so the demo sits under its own divider rather than in the generic footer
 * card, with copy that names it for what it is.
 */

const copy = {
  en: {
    subject: "Verify your email to start using BAU AI",
    preheader:
      "One click to confirm your address — then your 7-day trial and company onboarding begin.",
    eyebrow: "One last step",
    title: "Verify your email address",
    greeting: (name: string) => `Hi ${name},`,
    body: "Thanks for creating your BAU AI account. Confirm this address to continue to company onboarding and start your 7-day free trial.",
    button: "Verify email address",
    fallback: "Button not working? Copy this link into your browser:",
    expiry:
      "This link expires in one hour. If you did not create a BAU AI account, you can safely ignore this email.",
    demoTitle: "Book your onboarding demo",
    demoBody:
      "Want us to walk you through it? Book a free 30-minute onboarding demo — we will set up your company profile with you and show you how BAU AI finds and analyses the tenders that fit your business.",
    demoButton: "Book onboarding demo",
    footerNote:
      "You are receiving this email because someone signed up for BAU AI with this address.",
  },
  de: {
    subject: "Bestätigen Sie Ihre E-Mail-Adresse für BAU AI",
    preheader:
      "Ein Klick zur Bestätigung — danach starten Ihre 7-tägige Testphase und das Onboarding.",
    eyebrow: "Nur noch ein Schritt",
    title: "E-Mail-Adresse bestätigen",
    greeting: (name: string) => `Hallo ${name},`,
    body: "Vielen Dank für die Erstellung Ihres BAU AI Kontos. Bestätigen Sie diese Adresse, um mit dem Unternehmens-Onboarding fortzufahren und Ihre kostenlose 7-tägige Testphase zu starten.",
    button: "E-Mail-Adresse bestätigen",
    fallback:
      "Button funktioniert nicht? Kopieren Sie diesen Link in Ihren Browser:",
    expiry:
      "Dieser Link läuft in einer Stunde ab. Falls Sie kein BAU AI Konto erstellt haben, können Sie diese E-Mail ignorieren.",
    demoTitle: "Onboarding-Demo buchen",
    demoBody:
      "Sollen wir Sie durch die Plattform führen? Buchen Sie eine kostenlose 30-minütige Onboarding-Demo — wir richten Ihr Unternehmensprofil gemeinsam mit Ihnen ein und zeigen Ihnen, wie BAU AI die passenden Ausschreibungen findet und analysiert.",
    demoButton: "Onboarding-Demo buchen",
    footerNote:
      "Sie erhalten diese E-Mail, weil sich jemand mit dieser Adresse bei BAU AI registriert hat.",
  },
} as const;

export function verificationEmail({
  locale,
  name,
  verificationUrl,
}: {
  locale: Locale;
  name: string;
  verificationUrl: string;
}): EmailDocument {
  const message = copy[locale];
  const demo = bookingUrl();

  const content = [
    paragraph(message.greeting(name), { tone: "ink", spaceAfter: 12 }),
    paragraph(message.body, { spaceAfter: 28 }),
    button({ href: verificationUrl, label: message.button }),
    rawLink(message.fallback, verificationUrl),
    paragraph(message.expiry, { tone: "muted", spaceAfter: 30 }),
    divider(28),
    outlinePanel(
      [
        panelHeading(message.demoTitle),
        paragraph(message.demoBody, { spaceAfter: 18 }),
        button({ href: demo, label: message.demoButton, variant: "ghost" }),
      ].join(""),
    ),
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
      // The demo has its own block above; the generic card would be the same
      // ask twice, but the footer link stays.
      booking: "footer",
    }),
    text: renderText({
      locale,
      title: message.title,
      booking: "footer",
      lines: [
        message.greeting(name),
        "",
        message.body,
        "",
        `${message.button}: ${verificationUrl}`,
        "",
        message.expiry,
        "",
        "—",
        message.demoTitle,
        message.demoBody,
        `${message.demoButton}: ${demo}`,
      ],
    }),
  };
}
