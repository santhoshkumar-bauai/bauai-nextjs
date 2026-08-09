import { Schema, model, models, type Model } from "mongoose";

import { DECISION_STATUSES } from "@/lib/tenders/pipeline-status";

/**
 * A company's decision about a tender: which kanban column it sits in, or that
 * it was set aside.
 *
 * One document per (company, tender) — moving a tender across columns updates
 * `status` rather than inserting a second row, so the board and the relevant
 * feed can never disagree about where a tender sits.
 *
 * The status vocabulary itself lives in `lib/tenders/pipeline-status` (no
 * Mongoose import, so client components can use it) and is re-exported here so
 * server-side callers keep importing it from the model.
 */
export {
  DECISION_STATUSES,
  HIDDEN_STATUSES,
  PIPELINE_STATUSES,
} from "@/lib/tenders/pipeline-status";
export type {
  DecisionStatus,
  PipelineStatus,
} from "@/lib/tenders/pipeline-status";

type DecisionStatusValue = (typeof DECISION_STATUSES)[number];

export interface TenderDecisionDocument {
  companyId: string;
  tenderId: string;
  status: DecisionStatusValue;
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
