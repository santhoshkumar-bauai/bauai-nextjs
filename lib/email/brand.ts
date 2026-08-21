/**
 * Constants every outbound email needs and cannot look up for itself.
 *
 * Nothing here may read `next/headers` or a `Request`: the most important mail
 * we send (a finished tender report) is composed inside a background job whose
 * originating request is long gone, so a link has no origin to inherit and must
 * be built from configuration instead.
 */

/**
 * The Outlook Bookings page.
 *
 * One page deliberately serves two jobs — the onboarding demo offered to a new
 * account and the support/feedback slot offered to an existing one — so it is a
 * single constant rather than two that drift apart.
 */
const DEFAULT_BOOKING_URL =
  "https://outlook.office.com/book/SupportFeedback@bauai.eu/?ismsaljsauthenabled=true";

/** Where "book a session" points. Override with `EMAIL_BOOKING_URL`. */
export function bookingUrl(): string {
  return process.env.EMAIL_BOOKING_URL?.trim() || DEFAULT_BOOKING_URL;
}

/** The reply-to address printed in the footer. */
export function supportEmail(): string {
  return process.env.EMAIL_SUPPORT_ADDRESS?.trim() || "info@bauai.eu";
}

/**
 * Browser-facing origin for links back into the app.
 *
 * `PUBLIC_APP_URL` first — it is the only var declared as "what a browser
 * types". `BETTER_AUTH_URL` is a fallback rather than the primary because it is
 * set to localhost in several environments, which would email dead links.
 */
function baseUrl(): string {
  const configured =
    process.env.PUBLIC_APP_URL?.trim() || process.env.BETTER_AUTH_URL?.trim();
  return (configured || "http://localhost:3000").replace(/\/+$/, "");
}

export function appUrl(path = "/"): string {
  return `${baseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
