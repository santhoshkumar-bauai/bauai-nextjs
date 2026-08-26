import { Annotation } from "@langchain/langgraph";

import type { FillField, FillIssue, OpenQuestion } from "./fieldmap.ts";
import type {
  DecisionGroup,
  FillActivityEvent,
  FillBatchState,
  FillCropRef,
  FillPageStrategy,
  ValueEvidence,
} from "./workflow-wire.ts";

function replace<T>(initial: () => T) {
  return Annotation<T>({ reducer: (_left, right) => right, default: initial });
}

export const FillWorkflowState = Annotation.Root({
  status: replace<
    "queued" | "inspecting" | "mapping" | "awaiting_input" | "filling" |
    "repairing" | "assembling" | "completed" | "needs_review"
  >(() => "queued"),
  pageStrategies: replace<FillPageStrategy[]>(() => []),
  batches: replace<FillBatchState[]>(() => []),
  currentBatchIndex: replace<number>(() => 0),
  fieldmap: replace<FillField[]>(() => []),
  evidence: replace<Record<string, ValueEvidence>>(() => ({})),
  decisions: replace<DecisionGroup[]>(() => []),
  openQuestions: replace<OpenQuestion[]>(() => []),
  issues: replace<FillIssue[]>(() => []),
  activeCrops: replace<FillCropRef[]>(() => []),
  activity: replace<FillActivityEvent[]>(() => []),
  /** Crop repairs spent across the WHOLE run — the run-wide counterpart to a
   * batch's per-region `attemptsByRegion`. Checkpointed with the rest of the
   * state, so it survives an await_input pause and cannot be reset by a
   * resume. See `fillWorkflowRecursionLimit`. */
  repairAttempts: replace<number>(() => 0),
});

export type FillWorkflowStateType = typeof FillWorkflowState.State;
