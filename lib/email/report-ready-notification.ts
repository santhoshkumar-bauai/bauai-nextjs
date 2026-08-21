import type { ObjectId } from "mongodb";

import type { Locale } from "@/i18n/config";
import {
  REPORT_LOCALES,
  type ReportLocale,
  type TenderReportContent,
} from "@/lib/ai/report/schema";
import type { TenderReportDocument } from "@/lib/ai/types";
import { mongoDatabase } from "@/lib/db/mongodb";
import { connectMongoose } from "@/lib/db/mongoose";
import { logger } from "@/lib/ingestion/observability/logger";
import { AccountProfile } from "@/models/account-profile";

import { appUrl } from "./brand";
import type { ReportDecision, ReportReadyData } from "./report-ready-email";
import { sendReportReadyEmails, type ReportReadyRecipient } from "./resend";

/**
 * Fans a finished tender report out to everyone in the company.
 *
 * The whole company rather than the person who pressed generate: a report takes
 * minutes, the requester has usually navigated away, and the decision it
 * carries — bid or don't, and by when — is a team decision. Each member is
 * mailed in the language on their own profile, because the request locale that
 * drives the auth emails does not exist here; the job has no request.
 *
 * Never throws. A notification failure must not turn a completed, already-paid
 * -for analysis into a failed run.
 */

const log = logger.child("email.report-ready");

/** Escape hatch for local development, where every run would mail the team. */
function disabled(): boolean {
  return process.env.EMAIL_REPORT_NOTIFICATIONS === "off";
}

/**
 * The language this recipient can actually be served.
 *
 * A translation can fail without failing the report (see `report/service.ts`),
 * so the recipient's own language is not guaranteed to be present.
 */
function resolveContent(
  doc: TenderReportDocument,
  preferred: ReportLocale,
): { content: TenderReportContent; locale: ReportLocale } | null {
  const locale =
    (doc.report[preferred] && preferred) ||
    (doc.report[doc.primaryLocale] && doc.primaryLocale) ||
    REPORT_LOCALES.find((entry) => doc.report[entry]);
  if (!locale) return null;

  const content = doc.report[locale] as unknown as TenderReportContent;
  if (!content?.recommendation) return null;
  return { content, locale };
}

/** The `immediate` steps, falling back to the top of an already-ordered plan. */
function firstActions(content: TenderReportContent): string[] {
  const plan = content.actionPlan ?? [];
  const immediate = plan
    .filter((entry) => entry.priority === "immediate")
    .map((entry) => entry.action);
  return immediate.length > 0
    ? immediate.slice(0, 3)
    : plan.slice(0, 3).map((entry) => entry.action);
}

export async function notifyReportReady(input: {
  /** The tenant id, which is the company `_id`. */
  tenantId: ObjectId;
  tenderId: ObjectId;
  report: TenderReportDocument;
}): Promise<void> {
  if (disabled()) return;

  try {
    await connectMongoose();
    const profiles = await AccountProfile.find({
      companyId: input.tenantId,
      membershipStatus: "active",
    })
      .select({ userId: 1, email: 1, locale: 1 })
      .lean();

    if (profiles.length === 0) {
      log.warn("no active members to notify", {
        tenderId: String(input.tenderId),
      });
      return;
    }

    // Names live on the Better Auth `user` document, which keys on a string
    // `id` mirroring `_id` — the same join the employees page does.
    const users = await mongoDatabase
      .collection<{ id: string; name?: string }>("user")
      .find(
        { id: { $in: profiles.map((profile) => profile.userId) } },
        { projection: { id: 1, name: 1 } },
      )
      .toArray();
    const nameById = new Map(users.map((user) => [user.id, user.name?.trim()]));

    const reportUrl = appUrl(`/tenders/${String(input.tenderId)}/report`);
    const requestedBy = input.report.generatedByUserId;
    const requestedByName =
      nameById.get(requestedBy) ||
      profiles.find((profile) => profile.userId === requestedBy)?.email ||
      null;

    const recipients: ReportReadyRecipient[] = [];
    for (const profile of profiles) {
      const resolved = resolveContent(input.report, profile.locale);
      if (!resolved) continue;
      const { content } = resolved;

      const data: ReportReadyData = {
        tenderTitle: input.report.tender.title ?? "",
        buyerName: input.report.tender.buyerName,
        submissionDeadline: input.report.tender.submissionDeadline,
        companyName: input.report.companyName,
        decision: content.recommendation.decision as ReportDecision,
        confidence: content.recommendation.confidence,
        headline: (content.executiveSummary ?? "").split(/\n{2,}/)[0] ?? "",
        requirementCount: content.requirements?.length ?? 0,
        gapCount: (content.requirements ?? []).filter(
          (entry) => entry.companyStatus === "gap",
        ).length,
        highRiskCount: (content.risks ?? []).filter(
          (entry) => entry.severity === "high",
        ).length,
        immediateActions: firstActions(content),
        reportUrl,
        // "Generated by you" is noise; only tell the rest of the team.
        requestedByName:
          profile.userId === requestedBy ? null : requestedByName,
      };

      recipients.push({
        email: profile.email,
        // The email is written in the reader's UI language, even when the
        // report itself had to fall back to another one.
        locale: profile.locale as Locale,
        data,
      });
    }

    if (recipients.length === 0) {
      log.warn("report has no readable language, nothing sent", {
        tenderId: String(input.tenderId),
      });
      return;
    }

    const { sent, failed } = await sendReportReadyEmails(recipients);
    log.info("report ready notification sent", {
      tenderId: String(input.tenderId),
      sent,
      failed: failed.length,
    });
    if (failed.length > 0) {
      log.warn("report notification rejected for some recipients", {
        tenderId: String(input.tenderId),
        recipients: failed,
      });
    }
  } catch (error) {
    log.error("report ready notification failed", {
      tenderId: String(input.tenderId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
