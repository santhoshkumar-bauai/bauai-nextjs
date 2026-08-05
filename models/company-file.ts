import { Schema, model, models, type Model, type Types } from "mongoose";

/**
 * File categories mirror the mvp1 upload sections. `logo` is the company logo;
 * the rest are knowledge-base document buckets. `general` documents are the ones
 * the profile auto-fill reads from.
 */
export const COMPANY_FILE_CATEGORIES = [
  "logo",
  "insurance",
  "certification",
  "reference-project",
  "general",
] as const;

export type CompanyFileCategory = (typeof COMPANY_FILE_CATEGORIES)[number];

/**
 * A user-uploaded company file backed by an S3 object. The bytes live in the
 * bucket; this collection holds only the metadata and the object key, so a
 * presigned URL can be minted on demand for reads. Replaces the untyped
 * `insurance_documents` / `certification_documents` / … JSON arrays mvp1 stored
 * on the company row.
 */
export interface CompanyFileDocument {
  companyId: Types.ObjectId;
  category: CompanyFileCategory;
  fileName: string;
  contentType: string;
  size: number;
  s3Bucket: string;
  s3Key: string;
  uploadedBy: string;
}

const companyFileSchema = new Schema<CompanyFileDocument>(
  {
    companyId: {
      type: Schema.Types.ObjectId,
      ref: "Company",
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: COMPANY_FILE_CATEGORIES,
      required: true,
    },
    fileName: { type: String, required: true, trim: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, min: 0 },
    s3Bucket: { type: String, required: true },
    s3Key: { type: String, required: true, unique: true },
    uploadedBy: { type: String, required: true },
  },
  { timestamps: true },
);

companyFileSchema.index({ companyId: 1, category: 1, createdAt: -1 });

export const CompanyFile =
  (models.CompanyFile as Model<CompanyFileDocument>) ||
  model<CompanyFileDocument>("CompanyFile", companyFileSchema);
