import { Schema, model, models, type Model } from "mongoose";

/**
 * A company's decision about a tender: which kanban column it sits in, or that
 * it was set aside.
 *
 * One document per (company, tender) — moving a tender across columns updates
 * `status` rather than inserting a second row, so the board and the relevant
 * feed can never disagree about where a tender sits.
 *
 * Two non-board states:
 *  - `deadzone` — rejected from the feed or removed from the board. Hidden from
 *    both, restorable from the Dead Zone view.
 *  - `deleted`  — dismissed permanently. The *tender* is never destroyed (the
 *    corpus is shared across companies); this only marks that this company
 *    never wants to see it again, and the UI offers no way back.
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

export interface TenderDecisionDocument {
  companyId: string;
  tenderId: string;
  status: DecisionStatus;
  decidedByUserId: string;
  /** Company member responsible for this tender; defaults to whoever moved it. */
  assigneeUserId?: string;
  createdAt: Date;
  updatedAt: Date;
}

const tenderDecisionSchema = new Schema<TenderDecisionDocument>(
  {
    companyId: { type: String, required: true, index: true },
    tenderId: { type: String, required: true },
    status: { type: String, required: true, enum: DECISION_STATUSES },
    decidedByUserId: { type: String, required: true },
    assigneeUserId: { type: String },
  },
  { timestamps: true, collection: "tender_decisions" },
);

// The board reads by (company, status); the feed reads by (company, tender).
tenderDecisionSchema.index({ companyId: 1, tenderId: 1 }, { unique: true });
tenderDecisionSchema.index({ companyId: 1, status: 1, updatedAt: -1 });

export const TenderDecision =
  (models.TenderDecision as Model<TenderDecisionDocument>) ||
  model<TenderDecisionDocument>("TenderDecision", tenderDecisionSchema);
