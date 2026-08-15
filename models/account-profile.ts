import { Schema, model, models, type Model, type Types } from "mongoose";

export const ONBOARDING_AGENT_STATUSES = [
  "not_started",
  "in_progress",
  "dismissed",
  "completed",
] as const;
export type OnboardingAgentStatus = (typeof ONBOARDING_AGENT_STATUSES)[number];

/**
 * Otto's per-user lifecycle state, kept beside `onboardingCompleted` rather
 * than in its own collection — this document already owns "where is this user
 * in getting started".
 *
 * Note the split with the LangGraph checkpointer: the CONVERSATION and the
 * working graph state live in `agent_checkpoints`, keyed by thread. What lives
 * here is the durable answer to "should Otto appear at all", which has to
 * survive a checkpoint wipe and be readable by a server component without
 * loading a graph.
 */
export interface OnboardingAgentState {
  status: OnboardingAgentStatus;
  /** Mirrored from graph state so the launcher can show progress cheaply. */
  plannedMilestoneIds: string[];
  completedMilestoneIds: string[];
  currentMilestoneId: string | null;
  dismissedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface AccountProfileDocument {
  userId: string;
  email: string;
  companyId: Types.ObjectId;
  role: "admin" | "member";
  membershipStatus: "active" | "pending" | "rejected";
  onboardingCompleted: boolean;
  locale: "en" | "de";
  trialStartsAt: Date;
  trialEndsAt: Date;
  onboardingAgent?: OnboardingAgentState;
}

const accountProfileSchema = new Schema<AccountProfileDocument>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true },
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    role: { type: String, enum: ["admin", "member"], required: true },
    membershipStatus: {
      type: String,
      enum: ["active", "pending", "rejected"],
      default: "active",
      index: true,
    },
    onboardingCompleted: { type: Boolean, default: false },
    locale: { type: String, enum: ["en", "de"], default: "en" },
    trialStartsAt: { type: Date, required: true },
    trialEndsAt: { type: Date, required: true },
    onboardingAgent: {
      // Absent on every profile created before Otto existed, which reads as
      // "not_started" — so existing users get offered the tour once, and a
      // dismissal is what stops it coming back.
      type: {
        status: {
          type: String,
          enum: ONBOARDING_AGENT_STATUSES,
          default: "not_started",
        },
        plannedMilestoneIds: { type: [String], default: [] },
        completedMilestoneIds: { type: [String], default: [] },
        currentMilestoneId: { type: String, default: null },
        dismissedAt: { type: Date, default: null },
        startedAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
      },
      required: false,
      default: undefined,
    },
  },
  { timestamps: true },
);

export const AccountProfile =
  (models.AccountProfile as Model<AccountProfileDocument>) ||
  model<AccountProfileDocument>("AccountProfile", accountProfileSchema);
