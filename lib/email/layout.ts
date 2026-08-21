import type { Locale } from "@/i18n/config";

import { appUrl, bookingUrl, supportEmail } from "./brand";

/**
 * The shared visual system for every BAU AI email.
 *
 * Email is not the web: there is no stylesheet, no flexbox worth relying on and
 * no component runtime, so this module is the design system — a fixed palette,
 * a table-based shell and a small set of block helpers that templates compose.
 * A template's job is copy and data; it should never hand-roll markup, because
 * the moment two templates draw their own button they stop looking like the
 * same product.
 *
 * Conventions that are load-bearing and easy to break:
 * - Every helper ESCAPES the strings it is given. Callers pass plain text.
 * - Layout styles are inline; only media queries and dark mode live in `<style>`,
 *   since those are the two things inline styles cannot express.
 * - No CSS gradients anywhere. Outlook drops them, and the fallback colour is
 *   what most recipients would see regardless — so the flat colour IS the
 *   design rather than a degraded version of it.
 * - Colour is structural, not decorative: purple marks the brand and the one
 *   primary action per email. Everything else is ink, rule and paper.
 */

export interface EmailDocument {
  subject: string;
  text: string;
  html: string;
}

/** Mirrors `app/globals.css`; kept literal because email cannot read CSS vars. */
export const palette = {
  ink: "#191724",
  body: "#544e5d",
  muted: "#8b8595",
  primary: "#5000a8",
  border: "#e6e1eb",
  rule: "#efecf3",
  page: "#f4f3f6",
  card: "#ffffff",
  positiveInk: "#106b4d",
  positiveBg: "#f1f8f4",
  cautionInk: "#8a5300",
  cautionBg: "#fdf7ed",
  criticalInk: "#9c2129",
  criticalBg: "#fdf2f2",
} as const;

export type Tone = "neutral" | "brand" | "positive" | "caution" | "critical";

const TONE: Record<Tone, { ink: string; bg: string }> = {
  neutral: { ink: palette.body, bg: "#f7f6f9" },
  brand: { ink: palette.primary, bg: "#f8f5fc" },
  positive: { ink: palette.positiveInk, bg: palette.positiveBg },
  caution: { ink: palette.cautionInk, bg: palette.cautionBg },
  critical: { ink: palette.criticalInk, bg: palette.criticalBg },
};

const FONT =
  "'Inter','Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif";

/** Displayed at a third of the asset's pixel width so it stays sharp on retina. */
const LOGO_WIDTH = 140;
const LOGO_HEIGHT = 30;

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      })[character]!,
  );
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

export function paragraph(
  text: string,
  options?: { tone?: "body" | "ink" | "muted"; spaceAfter?: number },
): string {
  const tone = options?.tone ?? "body";
  const colour =
    tone === "ink" ? palette.ink : tone === "muted" ? palette.muted : palette.body;
  const size = tone === "muted" ? 13 : 15;
  const cls = tone === "ink" ? "bau-ink" : tone === "muted" ? "bau-muted" : "bau-body";
  return `<p class="${cls}" style="margin:0 0 ${options?.spaceAfter ?? 16}px;color:${colour};font-size:${size}px;line-height:1.65;mso-line-height-rule:exactly">${escapeHtml(text)}</p>`;
}

/** A quiet label introducing a group of blocks. */
export function sectionLabel(text: string): string {
  return `<p class="bau-ink" style="margin:0 0 12px;color:${palette.ink};font-size:13px;font-weight:700;letter-spacing:-.01em;mso-line-height-rule:exactly">${escapeHtml(text)}</p>`;
}

/**
 * A callout marked by a rule down its left edge.
 *
 * A rule rather than a tinted, rounded box: three of those stacked is what
 * makes an email look generated. `children` must already be rendered blocks.
 */
export function calloutPanel(children: string, tone: Tone = "neutral"): string {
  const colours = TONE[tone];
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 26px"><tr>
    <td width="3" bgcolor="${colours.ink}" style="width:3px;background:${colours.ink};font-size:0;line-height:0">&nbsp;</td>
    <td class="bau-panel" bgcolor="${colours.bg}" style="background:${colours.bg};padding:18px 22px">${children}</td>
  </tr></table>`;
}

/** A plain bordered box — used for the footer's booking ask. */
export function outlinePanel(children: string): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 4px"><tr>
    <td class="bau-outline" style="border:1px solid ${palette.border};border-radius:8px;padding:22px 24px">${children}</td>
  </tr></table>`;
}

export function panelHeading(text: string): string {
  return `<p class="bau-ink" style="margin:0 0 8px;color:${palette.ink};font-size:15px;font-weight:700;letter-spacing:-.01em;line-height:1.4;mso-line-height-rule:exactly">${escapeHtml(text)}</p>`;
}

/**
 * The primary call to action.
 *
 * Outlook (word-rendered) ignores padding on an anchor and border-radius
 * entirely, so it gets a VML rectangle instead — the width has to be guessed
 * from the label because VML cannot size to its content.
 */
export function button(input: {
  href: string;
  label: string;
  variant?: "primary" | "ghost";
}): string {
  const href = escapeHtml(input.href);
  const label = escapeHtml(input.label);
  const ghost = input.variant === "ghost";
  const fill = ghost ? palette.card : palette.primary;
  const ink = ghost ? palette.ink : "#ffffff";
  const width = Math.round(input.label.length * 8.2) + 52;

  return `<table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 4px"><tr><td>
    <!--[if mso]>
    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:46px;v-text-anchor:middle;width:${width}px;" arcsize="18%" ${ghost ? `strokecolor="${palette.border}"` : 'stroke="f"'} fillcolor="${fill}">
      <w:anchorlock/>
      <center style="color:${ink};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${label}</center>
    </v:roundrect>
    <![endif]-->
    <!--[if !mso]><!-- -->
    <a class="${ghost ? "bau-ghost" : ""}" href="${href}" style="display:inline-block;padding:14px 26px;background:${fill};color:${ink};text-decoration:none;border:1px solid ${ghost ? palette.border : palette.primary};border-radius:8px;font-family:${FONT};font-size:15px;font-weight:600;line-height:1;mso-line-height-rule:exactly">${label}</a>
    <!--<![endif]-->
  </td></tr></table>`;
}

/**
 * A hairline-bounded strip of headline numbers. Collapses to one per line on
 * narrow screens — three columns of small text is unreadable on a phone.
 */
export function statStrip(
  stats: Array<{ label: string; value: string; tone?: Tone }>,
): string {
  if (stats.length === 0) return "";
  const width = Math.floor(100 / stats.length);
  const cells = stats
    .map((stat) => {
      const ink = stat.tone ? TONE[stat.tone].ink : palette.ink;
      // A toned number keeps its own colour in dark mode; only the neutral one
      // takes the `.bau-ink` override, which would otherwise flatten all three
      // to the same white and throw away the signal.
      return `<td class="bau-stat" width="${width}%" valign="top" style="padding:0 12px 0 0">
        <p class="${stat.tone ? "" : "bau-ink"}" style="margin:0 0 3px;color:${ink};font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.15;mso-line-height-rule:exactly">${escapeHtml(stat.value)}</p>
        <p class="bau-muted" style="margin:0;color:${palette.muted};font-size:12px;line-height:1.4;mso-line-height-rule:exactly">${escapeHtml(stat.label)}</p>
      </td>`;
    })
    .join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 34px">
    <tr><td colspan="${stats.length}" class="bau-rule" height="1" bgcolor="${palette.rule}" style="background:${palette.rule};height:1px;line-height:1px;font-size:0">&nbsp;</td></tr>
    <tr><td colspan="${stats.length}" height="18" style="height:18px;font-size:0;line-height:0">&nbsp;</td></tr>
    <tr>${cells}</tr>
  </table>`;
}

/** Label/value pairs — deadlines, buyer, procedure. */
export function factRows(rows: Array<{ label: string; value: string }>): string {
  if (rows.length === 0) return "";
  const cells = rows
    .map(
      (row, index) => `<tr>
        <td width="42%" valign="top" class="bau-muted" style="padding:${index === 0 ? 0 : 11}px 16px 11px 0;color:${palette.muted};font-size:13px;line-height:1.5;mso-line-height-rule:exactly">${escapeHtml(row.label)}</td>
        <td valign="top" class="bau-ink" style="padding:${index === 0 ? 0 : 11}px 0 11px;color:${palette.ink};font-size:13px;font-weight:600;line-height:1.5;mso-line-height-rule:exactly">${escapeHtml(row.value)}</td>
      </tr>`,
    )
    .join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 26px">${cells}</table>`;
}

/** A numbered list. `<ol>` margins are unreliable in email, so it is a table. */
export function orderedList(items: string[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map(
      (item, index) => `<tr>
        <td width="22" valign="top" class="bau-muted" style="padding:0 12px 12px 0;color:${palette.muted};font-size:14px;font-weight:600;line-height:1.6;mso-line-height-rule:exactly">${index + 1}.</td>
        <td valign="top" class="bau-body" style="padding:0 0 12px;color:${palette.body};font-size:14px;line-height:1.6;mso-line-height-rule:exactly">${escapeHtml(item)}</td>
      </tr>`,
    )
    .join("");
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 24px">${rows}</table>`;
}

/**
 * The raw URL, spelled out under a button.
 *
 * Corporate mail gateways rewrite or strip anchors often enough that a one-time
 * link with no visible fallback is a support ticket waiting to happen.
 */
export function rawLink(label: string, url: string): string {
  return `<p class="bau-muted" style="margin:18px 0 22px;color:${palette.muted};font-size:12px;line-height:1.6;mso-line-height-rule:exactly">${escapeHtml(label)}<br><a class="bau-link" href="${escapeHtml(url)}" style="color:${palette.primary};text-decoration:underline;word-break:break-all">${escapeHtml(url)}</a></p>`;
}

export function divider(spaceAfter = 26): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 ${spaceAfter}px"><tr><td class="bau-rule" height="1" bgcolor="${palette.rule}" style="background:${palette.rule};height:1px;line-height:1px;font-size:0">&nbsp;</td></tr></table>`;
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

const footerCopy = {
  en: {
    bookingTitle: "Prefer a guided walkthrough?",
    bookingBody:
      "Book a 30-minute session with the BAU AI team — onboarding demo, product questions or feedback.",
    bookingButton: "Book a session",
    openApp: "Open BAU AI",
    defaultNote: "You are receiving this email because you have a BAU AI account.",
    help: "Questions? Reply to this email or write to",
    logoAlt: "BAU AI",
  },
  de: {
    bookingTitle: "Lieber eine geführte Tour?",
    bookingBody:
      "Buchen Sie einen 30-minütigen Termin mit dem BAU AI Team — Onboarding-Demo, Produktfragen oder Feedback.",
    bookingButton: "Termin buchen",
    openApp: "BAU AI öffnen",
    defaultNote: "Sie erhalten diese E-Mail, weil Sie ein BAU AI Konto haben.",
    help: "Fragen? Antworten Sie auf diese E-Mail oder schreiben Sie an",
    logoAlt: "BAU AI",
  },
} as const;

/**
 * The wordmark.
 *
 * A hosted PNG, not the SVG the app uses: Gmail, Outlook and most mobile
 * clients drop `<img>` sources that are SVG or `data:`, which would leave the
 * header empty. Two versions are emitted and swapped by the dark-mode media
 * query, because the purple mark is unreadable on a dark card.
 */
function wordmark(alt: string): string {
  const common = `width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="${escapeHtml(alt)}" style="display:block;width:${LOGO_WIDTH}px;height:${LOGO_HEIGHT}px;border:0;outline:none;text-decoration:none"`;
  return `<span class="bau-logo-light"><img src="${escapeHtml(appUrl("/brand/email-logo.png"))}" ${common}></span>
    <!--[if !mso]><!-- -->
    <span class="bau-logo-dark" style="display:none;max-height:0;overflow:hidden;mso-hide:all"><img src="${escapeHtml(appUrl("/brand/email-logo-white.png"))}" ${common}></span>
    <!--<![endif]-->`;
}

/** The booking ask, also exported so a template can promote it into the body. */
export function bookingCard(locale: Locale): string {
  const copy = footerCopy[locale];
  return outlinePanel(
    [
      panelHeading(copy.bookingTitle),
      paragraph(copy.bookingBody, { spaceAfter: 18 }),
      button({ href: bookingUrl(), label: copy.bookingButton, variant: "ghost" }),
    ].join(""),
  );
}

/**
 * How prominently an email asks the reader to book time with the team.
 *
 * `none` means exactly none — not even the link in the bottom nav. Password
 * reset needs that: a security email whose footer sells a demo undermines the
 * "ignore this if it wasn't you" instruction that is the whole point.
 */
export type BookingPlacement = "card" | "footer" | "none";

/**
 * Wraps rendered blocks in the branded shell.
 *
 * `preheader` is the grey line a client shows next to the subject in the inbox
 * list. Left unset, clients scrape the first visible text — which here is the
 * logo's alt text, so every email would preview as "BAU AI". It is always worth
 * writing.
 */
export function renderEmail(input: {
  locale: Locale;
  preheader: string;
  /** A short line above the headline saying what kind of mail this is. */
  eyebrow: string;
  title: string;
  /** Rendered blocks — compose with the helpers above. */
  content: string;
  /** Overrides the "you have a BAU AI account" line in the fine print. */
  footerNote?: string;
  /** Defaults to the full card. */
  booking?: BookingPlacement;
}): string {
  const copy = footerCopy[input.locale];
  const note = input.footerNote ?? copy.defaultNote;
  const support = supportEmail();
  const booking = input.booking ?? "card";

  return `<!doctype html>
<html lang="${input.locale}" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(input.title)}</title>
<!--[if mso]><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml><![endif]-->
<style>
  body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
  table,td{mso-table-lspace:0;mso-table-rspace:0}
  img{border:0;line-height:100%;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic}
  a{color:${palette.primary}}
  @media only screen and (max-width:620px){
    .bau-card{width:100%!important}
    .bau-pad{padding-left:24px!important;padding-right:24px!important}
    .bau-h1{font-size:23px!important}
    .bau-stat{display:block!important;width:100%!important;padding:0 0 16px!important}
    .bau-stack{display:block!important;width:100%!important;text-align:left!important;padding:4px 0 0!important}
  }
  @media (prefers-color-scheme:dark){
    .bau-page{background:#100e14!important}
    .bau-card{background:#1a1721!important;border-color:#302a3a!important}
    .bau-ink{color:#f4f2f7!important}
    .bau-body{color:#bcb6c6!important}
    .bau-muted{color:#8e8899!important}
    .bau-panel{background:#241f2e!important}
    .bau-outline{border-color:#302a3a!important}
    .bau-rule{background:#302a3a!important}
    .bau-ghost{background:#1a1721!important;border-color:#302a3a!important;color:#f4f2f7!important}
    .bau-link{color:#c19bf5!important}
    .bau-logo-light{display:none!important}
    .bau-logo-dark{display:inline!important;max-height:none!important;overflow:visible!important}
  }
</style>
</head>
<body class="bau-page" style="margin:0;padding:0;width:100%;background:${palette.page};font-family:${FONT};color:${palette.ink}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(input.preheader)}</div>
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all">&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>

<table width="100%" cellpadding="0" cellspacing="0" role="presentation" class="bau-page" bgcolor="${palette.page}" style="background:${palette.page}">
  <tr><td align="center" style="padding:40px 16px 32px">

    <table class="bau-card" width="600" cellpadding="0" cellspacing="0" role="presentation" bgcolor="${palette.card}" style="width:600px;max-width:600px;background:${palette.card};border:1px solid ${palette.border};border-radius:12px;overflow:hidden">

      <tr><td class="bau-pad" style="padding:30px 40px 26px">${wordmark(copy.logoAlt)}</td></tr>
      <tr><td class="bau-rule" height="1" bgcolor="${palette.rule}" style="background:${palette.rule};height:1px;line-height:1px;font-size:0">&nbsp;</td></tr>

      <tr><td class="bau-pad" style="padding:34px 40px 30px">
        <p class="bau-muted" style="margin:0 0 10px;color:${palette.muted};font-size:13px;line-height:1.4;mso-line-height-rule:exactly">${escapeHtml(input.eyebrow)}</p>
        <h1 class="bau-ink bau-h1" style="margin:0 0 20px;color:${palette.ink};font-size:26px;font-weight:700;line-height:1.25;letter-spacing:-.028em;mso-line-height-rule:exactly">${escapeHtml(input.title)}</h1>
        ${input.content}
      </td></tr>

      ${
        booking === "card"
          ? `<tr><td class="bau-pad" style="padding:0 40px 30px">${bookingCard(input.locale)}</td></tr>`
          : ""
      }

      <tr><td class="bau-rule" height="1" bgcolor="${palette.rule}" style="background:${palette.rule};height:1px;line-height:1px;font-size:0">&nbsp;</td></tr>
      <tr><td class="bau-pad" style="padding:24px 40px 28px">
        <p class="bau-muted" style="margin:0 0 6px;color:${palette.muted};font-size:12px;line-height:1.6;mso-line-height-rule:exactly">${escapeHtml(copy.help)} <a class="bau-link" href="mailto:${escapeHtml(support)}" style="color:${palette.primary};text-decoration:none;font-weight:600">${escapeHtml(support)}</a>.</p>
        <p class="bau-muted" style="margin:0;color:${palette.muted};font-size:12px;line-height:1.6;mso-line-height-rule:exactly">${escapeHtml(note)}</p>
      </td></tr>

    </table>

    <table width="600" cellpadding="0" cellspacing="0" role="presentation" class="bau-card" style="width:600px;max-width:600px">
      <tr><td align="center" style="padding:20px 24px 0">
        <p class="bau-muted" style="margin:0;color:${palette.muted};font-size:12px;line-height:1.6;mso-line-height-rule:exactly">
          <a href="${escapeHtml(appUrl("/dashboard"))}" style="color:${palette.muted};text-decoration:none">${escapeHtml(copy.openApp)}</a>
          &nbsp;&middot;&nbsp;
          ${
            booking === "none"
              ? ""
              : `<a href="${escapeHtml(bookingUrl())}" style="color:${palette.muted};text-decoration:none">${escapeHtml(copy.bookingButton)}</a>
          &nbsp;&middot;&nbsp;`
          }
          <span>&copy; ${new Date().getFullYear()} BAU AI</span>
        </p>
      </td></tr>
    </table>

  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Assembles the plain-text alternative.
 *
 * Not optional: a message with no text part is scored as spam by most filters,
 * and it is the only version some clients will ever render.
 */
export function renderText(input: {
  locale: Locale;
  title: string;
  lines: string[];
  booking?: BookingPlacement;
}): string {
  const copy = footerCopy[input.locale];
  const parts = ["BAU AI", "", input.title, "", ...input.lines];
  // Only the card has a text equivalent: a footer nav link is chrome, and a
  // template using `footer` has already written its own booking copy.
  if ((input.booking ?? "card") === "card") {
    parts.push("", "—", copy.bookingTitle, `${copy.bookingButton}: ${bookingUrl()}`);
  }
  parts.push("", `${copy.help} ${supportEmail()}.`);
  return parts.join("\n").replace(/\n{3,}/g, "\n\n");
}
