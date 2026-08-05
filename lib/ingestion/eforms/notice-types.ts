import type { BusinessCategory, NoticeClassification } from "../types.ts";

/**
 * All 21 eForms notice type codes, mapped exactly as specified in architecture
 * section 7. The old two-way `CN` versus `CAN` classifier is deliberately gone:
 * PIN, VEAT, consultation, completion, and registration notices each need
 * different application handling, and collapsing them loses that.
 */
interface NoticeTypeSpec {
  businessCategory: BusinessCategory;
  /** Whether a user could plausibly submit against this notice. */
  isPotentiallyBiddable: boolean;
  /** Shown in the tender opportunity UI by default. */
  visibleByDefault: boolean;
}

export const noticeTypeSpecs: Record<string, NoticeTypeSpec> = {
  // Open competitions.
  "cn-standard": {
    businessCategory: "OPEN_OPPORTUNITY",
    isPotentiallyBiddable: true,
    visibleByDefault: true,
  },
  "cn-social": {
    businessCategory: "OPEN_OPPORTUNITY",
    isPotentiallyBiddable: true,
    visibleByDefault: true,
  },
  "cn-desg": {
    businessCategory: "OPEN_OPPORTUNITY",
    isPotentiallyBiddable: true,
    visibleByDefault: true,
  },

  // Prior information notices used as a call for competition.
  "pin-cfc-standard": {
    businessCategory: "OPEN_OR_EARLY_COMPETITION",
    isPotentiallyBiddable: true,
    visibleByDefault: true,
  },
  "pin-cfc-social": {
    businessCategory: "OPEN_OR_EARLY_COMPETITION",
    isPotentiallyBiddable: true,
    visibleByDefault: true,
  },

  // Specialised qualification and subcontracting opportunities.
  "qu-sy": {
    businessCategory: "OPEN_OPPORTUNITY",
    isPotentiallyBiddable: true,
    visibleByDefault: true,
  },
  subco: {
    businessCategory: "OPEN_OPPORTUNITY",
    isPotentiallyBiddable: true,
    visibleByDefault: true,
  },

  // Planning notices: upcoming, not an ordinary open contract notice.
  "pin-only": {
    businessCategory: "UPCOMING_OPPORTUNITY",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },
  "pin-buyer": {
    businessCategory: "UPCOMING_OPPORTUNITY",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },
  "pin-rtl": {
    businessCategory: "UPCOMING_OPPORTUNITY",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },
  "pin-tran": {
    businessCategory: "UPCOMING_OPPORTUNITY",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },

  // Preliminary market consultation.
  pmc: {
    businessCategory: "MARKET_CONSULTATION",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },

  // Award results.
  "can-standard": {
    businessCategory: "AWARD_RESULT",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },
  "can-social": {
    businessCategory: "AWARD_RESULT",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },
  "can-desg": {
    businessCategory: "AWARD_RESULT",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },
  "can-tran": {
    businessCategory: "AWARD_RESULT",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },

  // Contract modification of an already awarded procedure.
  "can-modif": {
    businessCategory: "CONTRACT_UPDATE",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },

  // Contract completion.
  compl: {
    businessCategory: "COMPLETED_CONTRACT",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },

  // Voluntary ex-ante transparency: a direct award, not a competition.
  veat: {
    businessCategory: "DIRECT_AWARD_NOTICE",
    isPotentiallyBiddable: false,
    visibleByDefault: true,
  },

  // Business registration notices: retained for completeness, normally hidden.
  "brin-ecs": {
    businessCategory: "BUSINESS_REGISTRATION_NOTICE",
    isPotentiallyBiddable: false,
    visibleByDefault: false,
  },
  "brin-eeig": {
    businessCategory: "BUSINESS_REGISTRATION_NOTICE",
    isPotentiallyBiddable: false,
    visibleByDefault: false,
  },
};

const unknownSpec: NoticeTypeSpec = {
  businessCategory: "UNKNOWN",
  isPotentiallyBiddable: false,
  visibleByDefault: false,
};

/**
 * An unrecognised code is preserved verbatim and categorised `UNKNOWN` rather
 * than guessed at. Section 15.3 alerts on a rising unknown rate, which is how a
 * new official notice type gets noticed instead of silently misfiled.
 */
export function classifyNoticeType(
  typeCode: string | null,
  subtypeCode: string | null,
  formType: string | null,
): NoticeClassification {
  const normalized = (typeCode ?? "").trim().toLowerCase();
  const spec = noticeTypeSpecs[normalized] ?? unknownSpec;

  return {
    typeCode: normalized || "unknown",
    subtypeCode: subtypeCode?.trim() || null,
    formType: formType?.trim() || null,
    businessCategory: spec.businessCategory,
    isPotentiallyBiddable: spec.isPotentiallyBiddable,
  };
}

export function isKnownNoticeType(typeCode: string): boolean {
  return typeCode.toLowerCase() in noticeTypeSpecs;
}

export function isVisibleByDefault(typeCode: string): boolean {
  return (noticeTypeSpecs[typeCode.toLowerCase()] ?? unknownSpec).visibleByDefault;
}
