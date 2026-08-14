import { connectMongoose } from "../../db/mongoose.ts";
import { completedMilestones } from "../../onboarding/completion.ts";
import { isMilestoneId, type MilestoneId } from "../../onboarding/milestones.ts";
import {
  AccountProfile,
  type OnboardingAgentStatus,
} from "../../../models/account-profile.ts";
import type { OttoRunContext } from "./context.ts";
import { buildOttoGraph } from "./graph.ts";
import type { OttoWireState } from "./state.ts";
import { onboardingThreadKey } from "./threads.ts";

/**
 * Reading and persisting Otto's state.
 *
 * Two stores, on purpose. The graph checkpoint owns the live conversation and
 * the working state; `AccountProfile.onboardingAgent` owns the durable "should
 * Otto appear, and how far did they get" — which a server component has to be
 * able to read without compiling a graph, and which must survive a checkpoint
 * reset. This module is the only place the two are reconciled.
 */

export async function readOttoGraphState(
  ctx: OttoRunContext,
): Promise<OttoWireState | null> {
  const graph = await buildOttoGraph(ctx);
  const snapshot = await graph.getState({
    configurable: { thread_id: onboardingThreadKey(ctx.tenantId, ctx.userId) },
  });

  const values = snapshot.values as Partial<OttoWireState> | undefined;
  if (!values || values.status === undefined) return null;

  return {
    status: values.status,
    userProfile: values.userProfile ?? {},
    pendingQuestion: values.pendingQuestion ?? null,
    plannedMilestones: values.plannedMilestones ?? [],
    currentMilestoneId: values.currentMilestoneId ?? null,
    completedMilestoneIds: values.completedMilestoneIds ?? [],
    attemptCount: values.attemptCount ?? 0,
  };
}

function onlyMilestoneIds(values: readonly unknown[]): MilestoneId[] {
  return values.filter(isMilestoneId);
}

/**
 * Mirror graph progress onto the account profile.
 *
 * Deliberately never downgrades a `dismissed` profile back to `in_progress`:
 * the user's decision to leave outranks anything the graph subsequently does,
 * and a late-arriving turn must not resurrect a dismissed tour.
 */
export async function syncOttoProfileState(input: {
  userId: string;
  graphState: OttoWireState;
}): Promise<void> {
  await connectMongoose();
  const profile = await AccountProfile.findOne({ userId: input.userId })
    .select({ onboardingAgent: 1 })
    .lean();
  if (profile?.onboardingAgent?.status === "dismissed") return;

  const completed = input.graphState.status === "completed";
  const status: OnboardingAgentStatus = completed ? "completed" : "in_progress";
  const now = new Date();

  await AccountProfile.updateOne(
    { userId: input.userId },
    {
      $set: {
        "onboardingAgent.status": status,
        "onboardingAgent.plannedMilestoneIds": onlyMilestoneIds(
          input.graphState.plannedMilestones,
        ),
        "onboardingAgent.completedMilestoneIds": onlyMilestoneIds(
          input.graphState.completedMilestoneIds,
        ),
        "onboardingAgent.currentMilestoneId": input.graphState.currentMilestoneId,
        ...(completed ? { "onboardingAgent.completedAt": now } : {}),
      },
      $setOnInsert: { "onboardingAgent.dismissedAt": null },
      // Only stamped once, so "when did they begin" survives later turns.
      $min: { "onboardingAgent.startedAt": now },
    },
  );
}

/** One-click exit that stays exited; the launcher reads this on every render. */
export async function setOttoStatus(input: {
  userId: string;
  status: OnboardingAgentStatus;
}): Promise<void> {
  await connectMongoose();
  await AccountProfile.updateOne(
    { userId: input.userId },
    {
      $set: {
        "onboardingAgent.status": input.status,
        ...(input.status === "dismissed"
          ? { "onboardingAgent.dismissedAt": new Date() }
          : {}),
        // Re-opening after a dismissal must clear the tombstone, or the pill
        // would keep offering to resume something already marked abandoned.
        ...(input.status === "in_progress"
          ? { "onboardingAgent.dismissedAt": null }
          : {}),
      },
    },
  );
}

/**
 * What the launcher needs, with completion re-derived from real data rather
 * than trusted from the mirror — someone who finished a milestone outside the
 * tour should see it ticked off the next time they open Otto.
 */
export async function readOttoSummary(ctx: OttoRunContext): Promise<{
  status: OnboardingAgentStatus;
  plannedMilestoneIds: MilestoneId[];
  completedMilestoneIds: MilestoneId[];
  currentMilestoneId: MilestoneId | null;
}> {
  await connectMongoose();
  const [profile, actuallyComplete] = await Promise.all([
    AccountProfile.findOne({ userId: ctx.userId }).select({ onboardingAgent: 1 }).lean(),
    completedMilestones(ctx.milestoneContext),
  ]);

  const stored = profile?.onboardingAgent;
  const planned = onlyMilestoneIds(stored?.plannedMilestoneIds ?? []);
  const current = stored?.currentMilestoneId;

  return {
    status: stored?.status ?? "not_started",
    plannedMilestoneIds: planned,
    completedMilestoneIds: actuallyComplete.filter(
      (id) => planned.length === 0 || planned.includes(id),
    ),
    currentMilestoneId: isMilestoneId(current) ? current : null,
  };
}
