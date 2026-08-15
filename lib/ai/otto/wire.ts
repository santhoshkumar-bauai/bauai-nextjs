import type { MilestoneId } from "../../onboarding/milestones.ts";

/**
 * Client-safe wire types for Otto: the profile question vocabulary and the
 * state slice pushed to the browser.
 *
 * This module must import NOTHING server-side — same rule as the Clara wire
 * module, and for the same reason. `state.ts` builds the LangGraph annotation
 * on top of these, and it pulls in the tool loop, which pulls in mongodb; a
 * component importing from there drags the driver into the browser bundle.
 */

/** The three things Otto asks about, in the order it asks them. */
export const PROFILE_QUESTIONS = ["role", "goal", "teamSize"] as const;
export type ProfileQuestionId = (typeof PROFILE_QUESTIONS)[number];

export const PROFILE_CHOICES = {
  role: ["owner", "bidManager", "estimator", "other"],
  goal: ["findTenders", "prepareBids", "organiseTeam"],
  teamSize: ["solo", "small", "large"],
} as const satisfies Record<ProfileQuestionId, readonly string[]>;

export type OttoProfile = Partial<Record<ProfileQuestionId, string>>;

export type OttoStatus =
  /** Still asking the profile questions. */
  | "profiling"
  /** Profile known, plan not yet chosen. */
  | "planning"
  /** Working through `plannedMilestones`. */
  | "guiding"
  /** Every planned milestone is done. */
  | "completed";

/**
 * The slice pushed to the browser as `state` SSE events. Deliberately not the
 * whole graph state: `messages` streams as tokens already, and nothing else
 * there is the client's business.
 */
export interface OttoWireState {
  status: OttoStatus;
  userProfile: OttoProfile;
  pendingQuestion: ProfileQuestionId | null;
  plannedMilestones: MilestoneId[];
  currentMilestoneId: MilestoneId | null;
  completedMilestoneIds: MilestoneId[];
  attemptCount: number;
}
