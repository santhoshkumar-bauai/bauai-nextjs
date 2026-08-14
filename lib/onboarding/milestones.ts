/**
 * The onboarding milestone registry — the single source of truth for what Otto
 * may guide someone through.
 *
 * The governing rule: THE MODEL NEVER EMITS A SELECTOR, A ROUTE, OR A DOM
 * INSTRUCTION. It picks ids from this file and orders them; deterministic code
 * turns an id into a route and a spotlight. That is what keeps a restyle from
 * silently breaking the tour, and what stops a prompt injection from turning
 * navigation into a primitive the model controls.
 *
 * Client-safe on purpose: metadata only, no database imports. The real
 * completion checks live in ./completion.ts (server-only) and are keyed by the
 * ids declared here, so a milestone cannot exist without a way to verify it.
 *
 * Copy rules:
 *  - `modelDescription` is ENGLISH and written for an LLM reader. It is the
 *    only prose the model sees about a milestone.
 *  - Everything the USER reads is an i18n key, never a literal — this product
 *    ships EN and DE, and messages/parity.test.ts enforces both.
 */

export const ONBOARDING_ROLES = ["admin", "member"] as const;
export type OnboardingRole = (typeof ONBOARDING_ROLES)[number];

export interface MilestoneStep {
  /**
   * A `data-tour` attribute selector, always. Never a class and never
   * nth-child: both break on the next styling change, silently.
   */
  selector: string;
  /** i18n key under `Otto.steps` for the spotlight caption. */
  copyKey: string;
}

export interface Milestone {
  id: MilestoneId;
  /** i18n key under `Otto.milestones` for the checklist label. */
  labelKey: string;
  /** i18n key under `Otto.milestones` for the one-line explanation. */
  bodyKey: string;
  /** English, for the model. Explains WHEN this milestone is worth doing. */
  modelDescription: string;
  relevantFor: readonly OnboardingRole[];
  route: string;
  steps: readonly MilestoneStep[];
  /**
   * Milestones that must be complete first. Enforced by the planner in code,
   * not by asking the model nicely — "generate a report" is meaningless before
   * a tender is in the workspace.
   */
  requires?: readonly MilestoneId[];
  /**
   * Whether this milestone applies at all right now. Distinct from
   * `isComplete`: an unavailable milestone is filtered OUT of the plan rather
   * than shown as pending. Guards the conditionally-rendered targets that
   * would otherwise make the tour point at nothing.
   */
  requiresMatchEnabled?: boolean;
  /**
   * The target exists ONLY while the milestone is pending — it lives inside an
   * empty state that disappears the moment the work is done.
   *
   * The dev-time selector check skips these, because on a finished account
   * their absence is correct rather than drift. They are still covered by
   * `selectors.test.ts`, which greps the component source and so catches a
   * genuine rename regardless of what any one account has done.
   */
  targetVanishesWhenComplete?: boolean;
}

export const MILESTONE_IDS = [
  "complete_company_profile",
  "build_ai_matches",
  "save_first_tender",
  "review_pipeline",
  "upload_first_document",
  "ask_clara",
  "generate_first_report",
] as const;

export type MilestoneId = (typeof MILESTONE_IDS)[number];

export const MILESTONES: Readonly<Record<MilestoneId, Milestone>> = {
  complete_company_profile: {
    id: "complete_company_profile",
    labelKey: "completeCompanyProfile.label",
    bodyKey: "completeCompanyProfile.body",
    modelDescription:
      "Fill in the company profile (services, CPV codes, region, certifications). " +
      "Everything else in the product is driven by this data — tender matching is " +
      "poor until it is reasonably complete. Only admins can edit it, so never " +
      "plan this for a member.",
    relevantFor: ["admin"],
    route: "/settings/company-info",
    // One step only: the completion meter in the settings sidebar would be the
    // natural second, but it is `hidden lg:block`, so a tablet-width tour would
    // spotlight nothing.
    steps: [
      { selector: '[data-tour="company-profile-form"]', copyKey: "companyProfileForm" },
    ],
  },

  build_ai_matches: {
    id: "build_ai_matches",
    labelKey: "buildAiMatches.label",
    bodyKey: "buildAiMatches.body",
    modelDescription:
      "Run AI matching for the first time, which scores open tenders against the " +
      "company profile. This is the product's core discovery surface. Best done " +
      "after the company profile has some substance, since matching reads it.",
    relevantFor: ["admin", "member"],
    route: "/tenders",
    requires: ["complete_company_profile"],
    requiresMatchEnabled: true,
    // "Build my AI matches" is the empty-state CTA on the tender feed: once a
    // run has completed the feed shows tenders instead and the button is gone.
    targetVanishesWhenComplete: true,
    steps: [{ selector: '[data-tour="build-ai-matches"]', copyKey: "buildAiMatches" }],
  },

  save_first_tender: {
    id: "save_first_tender",
    labelKey: "saveFirstTender.label",
    bodyKey: "saveFirstTender.body",
    modelDescription:
      "Move a tender from the feed into the workspace using the 'To Workspace' " +
      "button on a tender card. This is the main conversion step: it is how a " +
      "tender enters the pipeline and becomes something the team works on.",
    relevantFor: ["admin", "member"],
    route: "/tenders",
    steps: [{ selector: '[data-tour="tender-card-save"]', copyKey: "tenderCardSave" }],
  },

  review_pipeline: {
    id: "review_pipeline",
    labelKey: "reviewPipeline.label",
    bodyKey: "reviewPipeline.body",
    modelDescription:
      "Visit the kanban board where saved tenders are tracked through Interested, " +
      "Preparing, Submitted, Won and Lost. Worth planning for anyone who will " +
      "coordinate a team; less useful for a solo user in a hurry.",
    relevantFor: ["admin", "member"],
    route: "/kanban",
    requires: ["save_first_tender"],
    steps: [{ selector: '[data-tour="kanban-board"]', copyKey: "kanbanBoard" }],
  },

  upload_first_document: {
    id: "upload_first_document",
    labelKey: "uploadFirstDocument.label",
    bodyKey: "uploadFirstDocument.body",
    modelDescription:
      "Upload a document to the document workspace, where it can be edited in " +
      "the browser with AI assistance from Dora. Relevant to anyone who will " +
      "actually prepare bid paperwork.",
    relevantFor: ["admin", "member"],
    route: "/document-filler",
    steps: [{ selector: '[data-tour="document-upload"]', copyKey: "documentUpload" }],
  },

  ask_clara: {
    id: "ask_clara",
    labelKey: "askClara.label",
    bodyKey: "askClara.body",
    modelDescription:
      "Ask Clara, the tender assistant, a first question. Clara can search the " +
      "company's documents and the tender corpus. A good early win because it " +
      "needs no setup and returns something useful immediately.",
    relevantFor: ["admin", "member"],
    route: "/chat",
    steps: [{ selector: '[data-tour="chat-suggestions"]', copyKey: "chatSuggestions" }],
  },

  generate_first_report: {
    id: "generate_first_report",
    labelKey: "generateFirstReport.label",
    bodyKey: "generateFirstReport.body",
    modelDescription:
      "Generate a full decision report for a tender — the deepest analysis the " +
      "product produces. Only meaningful once a tender is in the workspace, and " +
      "it is a slow step, so plan it last if at all.",
    relevantFor: ["admin", "member"],
    route: "/kanban",
    requires: ["save_first_tender"],
    steps: [{ selector: '[data-tour="kanban-board"]', copyKey: "reportFromBoard" }],
  },
};

/** Narrowing guard for anything arriving from the model or the wire. */
export function isMilestoneId(value: unknown): value is MilestoneId {
  return (
    typeof value === "string" && (MILESTONE_IDS as readonly string[]).includes(value)
  );
}

export function getMilestone(id: MilestoneId): Milestone {
  return MILESTONES[id];
}

/** Every distinct route a milestone can send someone to. */
export const MILESTONE_ROUTES: readonly string[] = [
  ...new Set(MILESTONE_IDS.map((id) => MILESTONES[id].route)),
];

/**
 * Milestones that could apply to this user at all, before completion is
 * considered. The planner picks from THIS list, so a member never gets an
 * admin-only step and nobody gets an AI-matching step on a deployment where
 * matching is switched off.
 */
export function availableMilestones(input: {
  role: OnboardingRole;
  matchEnabled: boolean;
}): Milestone[] {
  return MILESTONE_IDS.map((id) => MILESTONES[id]).filter((milestone) => {
    if (!milestone.relevantFor.includes(input.role)) return false;
    if (milestone.requiresMatchEnabled && !input.matchEnabled) return false;
    return true;
  });
}

/**
 * Drop ids that are unavailable, unknown, or duplicated, then topologically
 * settle `requires` so a prerequisite always precedes its dependant.
 *
 * The model proposes an ORDER; this decides whether that order is legal. A
 * dependency whose prerequisite was not planned at all is dropped rather than
 * silently inserted — the plan should reflect what the user agreed to.
 */
export function sanitizePlan(input: {
  proposed: readonly string[];
  role: OnboardingRole;
  matchEnabled: boolean;
}): MilestoneId[] {
  const allowed = new Set(
    availableMilestones({ role: input.role, matchEnabled: input.matchEnabled }).map(
      (milestone) => milestone.id,
    ),
  );

  const requested: MilestoneId[] = [];
  for (const candidate of input.proposed) {
    if (!isMilestoneId(candidate)) continue;
    if (!allowed.has(candidate)) continue;
    if (requested.includes(candidate)) continue;
    requested.push(candidate);
  }

  const planned = new Set(requested);
  const ordered: MilestoneId[] = [];
  const visiting = new Set<MilestoneId>();

  const visit = (id: MilestoneId): void => {
    if (ordered.includes(id)) return;
    // A cycle cannot happen with a static registry, but a guard here beats a
    // stack overflow if someone ever edits `requires` carelessly.
    if (visiting.has(id)) return;
    visiting.add(id);
    for (const prerequisite of MILESTONES[id].requires ?? []) {
      if (planned.has(prerequisite)) visit(prerequisite);
    }
    visiting.delete(id);
    if (!ordered.includes(id)) ordered.push(id);
  };

  for (const id of requested) visit(id);

  // A milestone whose prerequisite was not planned is not reachable.
  return ordered.filter((id) =>
    (MILESTONES[id].requires ?? []).every((prerequisite) => planned.has(prerequisite)),
  );
}
