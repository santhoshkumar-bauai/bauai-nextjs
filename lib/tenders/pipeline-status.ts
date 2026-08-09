/**
 * The decision vocabulary shared by the kanban board, the relevant feed and the
 * tender detail surfaces.
 *
 * It lives here rather than in `models/tender-decision` so client components
 * can import the lists without dragging Mongoose into the browser bundle; the
 * model re-exports everything for server-side callers.
 *
 * Two non-board states:
 *  - `deadzone` — rejected from the feed or removed from the board. Hidden from
 *    both, restorable from the Dead Zone view.
 *  - `deleted`  — dismissed permanently, with no way back in the UI.
 */
export const PIPELINE_STATUSES = [
  "interested",
  "preparing",
  "submitted",
  "won",
  "lost",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const DECISION_STATUSES = [
  ...PIPELINE_STATUSES,
  "deadzone",
  "deleted",
] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Statuses that keep a tender out of the relevant feed. */
export const HIDDEN_STATUSES = ["deadzone", "deleted"] as const;

/** True when the tender sits in a kanban column (i.e. "in workspace"). */
export function isPipelineStatus(
  status: string | null | undefined,
): status is PipelineStatus {
  return (
    status != null && (PIPELINE_STATUSES as readonly string[]).includes(status)
  );
}
