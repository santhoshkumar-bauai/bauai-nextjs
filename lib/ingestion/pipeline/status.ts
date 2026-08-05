import { ingestionEnv } from "../config/env.ts";
import type { BusinessCategory, SourceNotice, TenderStatus } from "../types.ts";

/**
 * Current status derivation (architecture section 7).
 *
 * The type code alone is not enough: cancellation state, award state, and the
 * deadline all participate, and lot-level deadlines are already folded into
 * `submissionDeadline` by the parser.
 */
export interface StatusInput {
  businessCategory: BusinessCategory;
  submissionDeadline: Date | null;
  isCancelled: boolean;
  isAwarded: boolean;
  now?: Date;
}

export function deriveStatus(input: StatusInput): TenderStatus {
  const now = input.now ?? new Date();

  // Cancellation and withdrawal outrank everything else: a cancelled procedure
  // must never be presented as open, whatever its deadline says.
  if (input.isCancelled) return "CANCELLED";

  switch (input.businessCategory) {
    case "COMPLETED_CONTRACT":
      return "COMPLETED";
    case "DIRECT_AWARD_NOTICE":
      return "DIRECT_AWARD";
    case "CONTRACT_UPDATE":
      return "MODIFIED";
    case "AWARD_RESULT":
      return "AWARDED";
    case "UPCOMING_OPPORTUNITY":
      return deadlineStatus(input.submissionDeadline, now) ?? "UPCOMING";
    case "MARKET_CONSULTATION":
      return deadlineStatus(input.submissionDeadline, now) ?? "UPCOMING";
    case "OPEN_OPPORTUNITY":
    case "OPEN_OR_EARLY_COMPETITION": {
      if (input.isAwarded) return "AWARDED";
      return deadlineStatus(input.submissionDeadline, now) ?? "OPEN";
    }
    case "BUSINESS_REGISTRATION_NOTICE":
      return "UNKNOWN";
    default:
      return "UNKNOWN";
  }
}

/**
 * Returns null when the deadline carries no information, so the caller keeps its
 * category default. An unknown deadline is never guessed at (§13.2).
 */
function deadlineStatus(deadline: Date | null, now: Date): TenderStatus | null {
  if (!deadline) return null;
  if (deadline.getTime() <= now.getTime()) return "CLOSED";

  const closingSoonMs = ingestionEnv.status.closingSoonHours * 3_600_000;
  if (deadline.getTime() - now.getTime() <= closingSoonMs) return "CLOSING_SOON";
  return "OPEN";
}

export function deriveStatusFromNotice(notice: SourceNotice, now?: Date): TenderStatus {
  return deriveStatus({
    businessCategory: notice.notice.businessCategory,
    submissionDeadline: notice.snapshot.submissionDeadline,
    isCancelled: notice.snapshot.isCancelled,
    isAwarded: notice.snapshot.isAwarded,
    now,
  });
}

/**
 * Whether the tender belongs in the default opportunity UI. Registration notices
 * and records with no usable title are retained but not surfaced (§7, §13.2).
 */
export function deriveVisibility(
  notice: SourceNotice,
  status: TenderStatus,
): boolean {
  if (notice.notice.businessCategory === "BUSINESS_REGISTRATION_NOTICE") return false;
  if (notice.notice.businessCategory === "UNKNOWN") return false;
  if (status === "UNKNOWN") return false;
  return Boolean(notice.snapshot.title.original || notice.snapshot.buyer?.name);
}

/**
 * Data quality score used for ranking and operational dashboards. Weighted by the
 * fields section 13.2 expects on a normally visible opportunity.
 */
export function scoreDataQuality(notice: SourceNotice): {
  score: number;
  warnings: string[];
} {
  const checks: Array<[boolean, number]> = [
    [Boolean(notice.snapshot.title.original), 0.25],
    [Boolean(notice.snapshot.buyer?.name), 0.15],
    [Boolean(notice.source.url), 0.1],
    [notice.notice.businessCategory !== "UNKNOWN", 0.15],
    [Boolean(notice.publication.publishedAt), 0.1],
    [notice.snapshot.cpvCodes.length > 0, 0.1],
    [notice.snapshot.countries.length > 0, 0.1],
    [
      Boolean(notice.snapshot.submissionDeadline) || !notice.notice.isPotentiallyBiddable,
      0.05,
    ],
  ];

  const score = checks.reduce((total, [passed, weight]) => total + (passed ? weight : 0), 0);
  return {
    score: Math.round(score * 100) / 100,
    warnings: notice.processing.warnings,
  };
}
