import { Schema, model, models, type Model, type Types } from "mongoose";

export const WORKSPACE_DOCUMENT_STATES = [
  "uploading",
  "converting",
  "ready",
  "conversion_failed",
  "save_failed",
  "deleting",
] as const;
export type WorkspaceDocumentState = (typeof WORKSPACE_DOCUMENT_STATES)[number];

export const WORKSPACE_DOCUMENT_TYPES = ["word", "cell", "pdf"] as const;
export type WorkspaceDocumentType = (typeof WORKSPACE_DOCUMENT_TYPES)[number];

export interface WorkspaceDocumentSource {
  kind: "upload" | "tender-copy" | "generated-fill";
  tenderRecordId?: string;
  tenderFileIndex?: number;
  sourceDocumentId?: Types.ObjectId;
  fillRunId?: Types.ObjectId;
}

export interface WorkspaceDocumentDocument {
  companyId: Types.ObjectId;
  tenderId?: Types.ObjectId | null;
  source: WorkspaceDocumentSource;
  fileName: string;
  extension: string;
  contentType: string;
  documentType: WorkspaceDocumentType;
  state: WorkspaceDocumentState;
  stateError?: string | null;
  currentVersionId?: Types.ObjectId | null;
  editorRevision: number;
  storageRevision: number;
  activeEditorKey: string;
  activeUserIds: string[];
  lastCallbackAt?: Date | null;
  createdBy: string;
  updatedBy: string;
  deletedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

const workspaceDocumentSchema = new Schema<WorkspaceDocumentDocument>(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    tenderId: { type: Schema.Types.ObjectId, default: null },
    source: {
      kind: {
        type: String,
        enum: ["upload", "tender-copy", "generated-fill"],
        required: true,
      },
      tenderRecordId: String,
      tenderFileIndex: Number,
      sourceDocumentId: { type: Schema.Types.ObjectId, ref: "WorkspaceDocument" },
      fillRunId: Schema.Types.ObjectId,
    },
    fileName: { type: String, required: true, trim: true },
    extension: { type: String, required: true, lowercase: true },
    contentType: { type: String, required: true },
    documentType: { type: String, enum: WORKSPACE_DOCUMENT_TYPES, required: true },
    state: { type: String, enum: WORKSPACE_DOCUMENT_STATES, required: true },
    stateError: { type: String, default: null },
    currentVersionId: { type: Schema.Types.ObjectId, default: null },
    editorRevision: { type: Number, required: true, min: 1, default: 1 },
    storageRevision: { type: Number, required: true, min: 0, default: 0 },
    activeEditorKey: { type: String, required: true },
    activeUserIds: { type: [String], default: [] },
    lastCallbackAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    updatedBy: { type: String, required: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

workspaceDocumentSchema.index({ companyId: 1, deletedAt: 1, updatedAt: -1 });
workspaceDocumentSchema.index({ companyId: 1, tenderId: 1, updatedAt: -1 });
workspaceDocumentSchema.index({ activeEditorKey: 1 });

export const WorkspaceDocument =
  (models.WorkspaceDocument as Model<WorkspaceDocumentDocument>) ||
  model<WorkspaceDocumentDocument>("WorkspaceDocument", workspaceDocumentSchema);
