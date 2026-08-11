import { Schema, model, models, type Model, type Types } from "mongoose";

export const WORKSPACE_VERSION_REASONS = [
  "upload",
  "conversion",
  "forcesave",
  "final",
  "restore",
] as const;
export type WorkspaceVersionReason = (typeof WORKSPACE_VERSION_REASONS)[number];

export interface WorkspaceDocumentVersionDocument {
  companyId: Types.ObjectId;
  documentId: Types.ObjectId;
  storageRevision: number;
  editorRevision: number;
  reason: WorkspaceVersionReason;
  state: "pending" | "committed" | "orphan";
  s3Bucket: string;
  s3Key: string;
  fileName: string;
  extension: string;
  contentType: string;
  size: number;
  sha256: string;
  editorKey?: string | null;
  callbackStatus?: number | null;
  onlyofficeHistory?: Record<string, unknown> | null;
  changesS3Key?: string | null;
  serverVersion?: string | null;
  createdBy: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const versionSchema = new Schema<WorkspaceDocumentVersionDocument>(
  {
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true },
    documentId: {
      type: Schema.Types.ObjectId,
      ref: "WorkspaceDocument",
      required: true,
    },
    storageRevision: { type: Number, required: true, min: 1 },
    editorRevision: { type: Number, required: true, min: 1 },
    reason: { type: String, enum: WORKSPACE_VERSION_REASONS, required: true },
    state: { type: String, enum: ["pending", "committed", "orphan"], required: true },
    s3Bucket: { type: String, required: true },
    s3Key: { type: String, required: true },
    fileName: { type: String, required: true },
    extension: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true },
    editorKey: { type: String, default: null },
    callbackStatus: { type: Number, default: null },
    onlyofficeHistory: { type: Schema.Types.Mixed, default: null },
    changesS3Key: { type: String, default: null },
    serverVersion: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

versionSchema.index({ documentId: 1, storageRevision: 1 }, { unique: true });
versionSchema.index({ companyId: 1, documentId: 1, createdAt: -1 });
versionSchema.index(
  { documentId: 1, editorKey: 1, callbackStatus: 1, sha256: 1 },
  {
    unique: true,
    partialFilterExpression: {
      editorKey: { $type: "string" },
      callbackStatus: { $type: "number" },
    },
  },
);

export const WorkspaceDocumentVersion =
  (models.WorkspaceDocumentVersion as Model<WorkspaceDocumentVersionDocument>) ||
  model<WorkspaceDocumentVersionDocument>(
    "WorkspaceDocumentVersion",
    versionSchema,
  );
