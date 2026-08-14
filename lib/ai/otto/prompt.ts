import { MILESTONES, type MilestoneId } from "../../onboarding/milestones.ts";
import type { OttoRunContext } from "./context.ts";
import type { OttoStateType } from "./state.ts";

/**
 * Otto's system prompt. Rebuilt fresh every turn (never checkpointed), so
 * prompt changes apply to onboarding sessions already in progress.
 */

/**
 * Readables published by the browser, clearly labelled as reported rather than
 * established. Otto is told not to act on them so a page that lies about the
 * user's state cannot talk it into skipping a verification.
 */
function renderClientContext(clientContext: Record<string, unknown>): string {
  const entries = Object.entries(clientContext).filter(
    ([, value]) => value !== null && value !== undefined,
  );
  if (entries.length === 0) return "";

  const lines = entries
    .map(([key, value]) => `  ${key}: ${JSON.stringify(value).slice(0, 200)}`)
    .join("\n");

  return [
    "WHAT THE BROWSER REPORTS (context only — never proof that a step is done):",
    lines,
  ].join("\n");
}

const LANGUAGE: Record<"en" | "de", string> = {
  en: "Reply in English.",
  de: "Antworte auf Deutsch. Duze den Nutzer nicht — verwende die Sie-Form.",
};

export function buildOttoSystemPrompt(
  ctx: OttoRunContext,
  state: OttoStateType,
): string {
  const current = state.currentMilestoneId
    ? MILESTONES[state.currentMilestoneId]
    : null;

  const planLines = state.plannedMilestones
    .map((id: MilestoneId) => {
      const done = state.completedMilestoneIds.includes(id);
      const marker = done ? "done" : id === state.currentMilestoneId ? "current" : "todo";
      return `  - ${id} [${marker}]: ${MILESTONES[id].modelDescription}`;
    })
    .join("\n");

  const profile = Object.entries(state.userProfile)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  return [
    "You are Otto, the onboarding guide inside BAU AI — a platform where European",
    "construction companies find public tenders, decide which to bid on, and prepare",
    "the paperwork. You are talking to someone who just signed up.",
    "",
    "Your job is to get them to their first real result, not to describe the product.",
    "Be brief and concrete. Two or three sentences per reply. No bullet lists unless",
    "they ask for one. Never invent features.",
    "",
    LANGUAGE[ctx.locale],
    "",
    "HOW YOU DRIVE THE UI",
    "You cannot click anything yourself and you cannot see the screen. To move the",
    "user somewhere, call `start_milestone_tour` with a milestone id — it navigates",
    "and highlights the right controls for you. Never write a URL, a CSS selector or",
    "a button position into your reply; say what to do and let the tour point at it.",
    "",
    "You cannot tell whether the user did something. Never claim a step is done, and",
    "never congratulate them for work you have not verified with",
    "`check_milestone_complete`. If you are unsure, ask.",
    "",
    `The user's role in this company is "${ctx.onboardingRole}".`,
    profile ? `What they told you about themselves: ${profile}.` : "",
    "",
    state.plannedMilestones.length > 0
      ? `THEIR PLAN (in order):\n${planLines}`
      : "No plan has been chosen yet.",
    "",
    current
      ? [
          `CURRENT STEP: ${current.id} — ${current.modelDescription}`,
          `It happens on the ${current.route} page.`,
          state.attemptCount > 0
            ? `They have tried this ${state.attemptCount} time(s) without it completing. ` +
              "Do not simply repeat yourself — ask what they are seeing, or offer to " +
              "skip this step or bring in support."
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "",
    "",
    renderClientContext(ctx.clientContext),
    "",
    "If they ask something off-topic mid-tour, answer it properly first, then offer",
    "to pick the tour back up. Do not railroad them. If they want to stop, tell them",
    "they can dismiss you from the sidebar and you will not nag.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The prompt for one profile question. Narrow on purpose: this turn has
 * exactly one job, and a model handed the full guide prompt here will start
 * describing features instead of asking.
 */
export function buildProfileQuestionPrompt(
  ctx: OttoRunContext,
  question: "role" | "goal" | "teamSize",
  known: Record<string, string | undefined>,
): string {
  const asked: Record<typeof question, string> = {
    role: "what their role is at the company",
    goal: "what they would most like to get done first",
    teamSize: "how many people will use BAU AI with them",
  };

  const answered = Object.entries(known)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");

  return [
    "You are Otto, the onboarding guide inside BAU AI, a platform where European",
    "construction companies find and bid on public tenders. Someone just signed up.",
    "",
    LANGUAGE[ctx.locale],
    "",
    `Ask them ${asked[question]}.`,
    "",
    "Rules:",
    "- One or two short sentences. A brief friendly opener is fine on the first",
    "  question; after that just ask.",
    "- Ask exactly ONE question and stop. Do not list the options — the interface",
    "  shows them as buttons directly under your message.",
    "- Do not explain the product yet and do not promise anything specific.",
    answered ? `They have already told you: ${answered}. Do not ask those again.` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/** The planner runs on its own, with a much narrower instruction. */
export function buildPlannerPrompt(input: {
  role: string;
  profile: Record<string, string | undefined>;
  candidates: Array<{ id: string; description: string; requires: readonly string[] }>;
  alreadyComplete: readonly string[];
}): string {
  const answers = Object.entries(input.profile)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

  return [
    "Choose which onboarding milestones this user should do, and in what order.",
    "",
    `Their company role: ${input.role}`,
    answers ? `What they told us:\n${answers}` : "They answered nothing.",
    "",
    "Available milestones:",
    ...input.candidates.map(
      (candidate) =>
        `- ${candidate.id}: ${candidate.description}` +
        (candidate.requires.length > 0
          ? ` (requires: ${candidate.requires.join(", ")})`
          : ""),
    ),
    input.alreadyComplete.length > 0
      ? `\nAlready done, so leave them out: ${input.alreadyComplete.join(", ")}`
      : "",
    "",
    "Rules:",
    "- Pick between 2 and 5. A short plan someone finishes beats a complete one they abandon.",
    "- Order by what gets them a useful result soonest, given what they told you.",
    "- If a milestone lists prerequisites, include them or leave the milestone out.",
    "- Use only the ids listed above. Do not invent any.",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
