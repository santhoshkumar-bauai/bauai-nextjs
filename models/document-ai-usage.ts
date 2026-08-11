import { Schema, model, models, type Model, type Types } from "mongoose";

export interface DocumentAiUsageDocument {
  companyId: Types.ObjectId;
  userId: string;
  documentId: Types.ObjectId;
  operation: "prefill" | "rewrite" | "review";
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  requestId: string;
  durationMs: number;
  outcome: "success" | "rejected" | "error";
  createdAt?: Date;
}

const usageSchema = new Schema<DocumentAiUsageDocument>(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    userId: { type: String, required: true },
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "WorkspaceDocument",
      required: true,
    },
    operation: { type: String, enum: ["prefill", "rewrite", "review"], required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    inputTokens: Number,
    outputTokens: Number,
    requestId: { type: String, required: true },
    durationMs: { type: Number, required: true, min: 0 },
    outcome: { type: String, enum: ["success", "rejected", "error"], required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

usageSchema.index({ companyId: 1, documentId: 1, createdAt: -1 });
usageSchema.index({ requestId: 1 }, { unique: true });

export const DocumentAiUsage =
  (models.DocumentAiUsage as Model<DocumentAiUsageDocument>) ||
  model<DocumentAiUsageDocument>("DocumentAiUsage", usageSchema);
