import { Annotation } from "@langchain/langgraph";

import type { MilestoneId } from "../../onboarding/milestones.ts";
import { toolLoopStateSpec } from "../agent/tool-loop.ts";
import type {
  OttoProfile,
  OttoStatus,
  OttoWireState,
  ProfileQuestionId,
} from "./wire.ts";

/**
 * Otto's graph state: the shared tool-loop channels plus everything the
 * onboarding machine needs to resume mid-tour after a refresh.
 *
 * Persisted by the same Mongo checkpointer Clara and Dora use, keyed by
 * `otto:{tenantId}:{userId}` — which is why a page reload picks up at the
 * current milestone instead of starting over.
 *
 * SERVER ONLY: importing this reaches the tool loop and therefore mongodb.
 * Components import ./wire.ts instead.
 */

export * from "./wire.ts";

/** Replace-on-write: the graph always sends the whole new value. */
function replace<T>(initial: () => T) {
  return Annotation<T>({ reducer: (_left, right) => right, default: initial });
}

export const OttoState = Annotation.Root({
  ...toolLoopStateSpec,

  userProfile: Annotation<OttoProfile>({
    // Merge, not replace: each turn answers one question and must not erase
    // the previous answers.
    reducer: (left, right) => ({ ...left, ...right }),
    default: () => ({}),
  }),

  /** The question awaiting an answer; the next user message answers it. */
  pendingQuestion: replace<ProfileQuestionId | null>(() => null),

  plannedMilestones: replace<MilestoneId[]>(() => []),
  currentMilestoneId: replace<MilestoneId | null>(() => null),
  completedMilestoneIds: replace<MilestoneId[]>(() => []),

  /**
   * Consecutive failed verifications of the CURRENT milestone. Reset on
   * advance. At two, Otto offers to skip or hand off rather than looping —
   * the same dead end twice is a product problem, not a prompting problem.
   */
  attemptCount: replace<number>(() => 0),

  status: replace<OttoStatus>(() => "profiling"),

  /**
   * Set by `verify` when it has just ticked a milestone off and another one
   * remains. It routes the turn straight back into `guide` so Otto introduces
   * the next step immediately, instead of going quiet and waiting to be
   * prodded with "next". Cleared on the second pass so the freshly-introduced
   * milestone is not instantly counted as a failed attempt.
   */
  justAdvanced: replace<boolean>(() => false),

  /** Auto-advances used this turn. Reset per turn; caps the verify↔guide hop. */
  autoAdvances: replace<number>(() => 0),
});

export type OttoStateType = typeof OttoState.State;

export function toWireState(state: OttoStateType): OttoWireState {
  return {
    status: state.status,
    userProfile: state.userProfile,
    pendingQuestion: state.pendingQuestion,
    plannedMilestones: state.plannedMilestones,
    currentMilestoneId: state.currentMilestoneId,
    completedMilestoneIds: state.completedMilestoneIds,
    attemptCount: state.attemptCount,
  };
}
