import { beforeEach, describe, expect, it } from "vitest";

import { locales } from "@/i18n/config";
import { reportReadyEmail, type ReportReadyData } from "./report-ready-email";
import { resetPasswordEmail } from "./reset-password-email";
import { verificationEmail } from "./verification-email";

/**
 * Templates are pure functions of copy and data, so the things worth asserting
 * are the ones a reader would only discover in production: a locale that has no
 * copy, an unescaped name, a link built from the wrong origin.
 */

const BOOKING = "https://outlook.office.com/book/SupportFeedback@bauai.eu/";

const reportData: ReportReadyData = {
  tenderTitle: "Neubau Grundschule Bergheim",
  buyerName: "Stadt Bergheim",
  submissionDeadline: new Date("2026-09-02T12:00:00Z"),
  companyName: "Müller & Sohn GmbH",
  decision: "conditional",
  confidence: 0.72,
  headline: "A strong technical match with two open eligibility items.",
  requirementCount: 27,
  gapCount: 2,
  highRiskCount: 3,
  immediateActions: ["Raise liability cover to €5m."],
  reportUrl: "https://app.bauai.eu/tenders/abc/report",
  requestedByName: "Anna Weber",
};

beforeEach(() => {
  process.env.PUBLIC_APP_URL = "https://app.bauai.eu";
  delete process.env.EMAIL_BOOKING_URL;
});

describe.each(locales)("%s", (locale) => {
  it("renders every template with a subject, text and html part", () => {
    const messages = [
      verificationEmail({ locale, name: "Anna", verificationUrl: "https://x/v" }),
      resetPasswordEmail({ locale, name: "Anna", resetUrl: "https://x/r" }),
      reportReadyEmail({ locale, data: reportData }),
    ];

    for (const message of messages) {
      expect(message.subject).not.toBe("");
      expect(message.text).not.toBe("");
      expect(message.html.startsWith("<!doctype html>")).toBe(true);
      // A stray `undefined` is how a missing copy key reaches an inbox.
      expect(message.html).not.toContain("undefined");
      expect(message.html).toContain(`lang="${locale}"`);
    }
  });

  it("uses hosted PNG logos, since clients drop SVG and data: sources", () => {
    const { html } = verificationEmail({
      locale,
      name: "Anna",
      verificationUrl: "https://x/v",
    });
    expect(html).toContain("https://app.bauai.eu/brand/email-logo.png");
    expect(html).toContain("https://app.bauai.eu/brand/email-logo-white.png");
    expect(html).not.toContain(".svg");
    expect(html).not.toContain("data:image");
  });

  it("offers the booking page as the onboarding demo when verifying", () => {
    const message = verificationEmail({
      locale,
      name: "Anna",
      verificationUrl: "https://x/v",
    });
    expect(message.html).toContain(BOOKING);
    expect(message.text).toContain(BOOKING);
  });

  it("keeps the password reset free of the booking ask", () => {
    const message = resetPasswordEmail({
      locale,
      name: "Anna",
      resetUrl: "https://x/r",
    });
    expect(message.html).not.toContain(BOOKING);
  });

  it("escapes recipient and tender text", () => {
    const { html } = reportReadyEmail({
      locale,
      data: { ...reportData, tenderTitle: '<script>alert("x")</script>' },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("names the decision, the deadline and the report link", () => {
    const { html, subject } = reportReadyEmail({ locale, data: reportData });
    expect(subject).toContain(reportData.tenderTitle);
    expect(html).toContain(reportData.reportUrl);
    expect(html).toContain("2026");
    expect(html).toContain("72%");
  });
});

it("falls back to a plain deadline row when the tender has no date", () => {
  const { html } = reportReadyEmail({
    locale: "en",
    data: { ...reportData, submissionDeadline: null },
  });
  expect(html).toContain("Not provided");
});

it("honours an overridden booking URL", () => {
  process.env.EMAIL_BOOKING_URL = "https://example.com/book";
  const { html } = verificationEmail({
    locale: "en",
    name: "Anna",
    verificationUrl: "https://x/v",
  });
  expect(html).toContain("https://example.com/book");
  expect(html).not.toContain(BOOKING);
});
