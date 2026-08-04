import { Schema, model, models, type Model } from "mongoose";

export type CompanyMemberRole = "admin" | "member";
export type MembershipRequestStatus = "pending" | "approved" | "rejected";

export interface CompanyDocument {
  name: string;
  domain: string;
  website: string;
  businessDomain: string;
  region: string;
  regionLocation?: {
    placeId: string;
    latitude: number;
    longitude: number;
  };
  services: string[];
  cpvCodes: string[];
  members: Array<{
    userId: string;
    email: string;
    role: CompanyMemberRole;
    joinedAt: Date;
  }>;
  membershipRequests: Array<{
    userId: string;
    email: string;
    status: MembershipRequestStatus;
    requestedAt: Date;
    reviewedAt?: Date;
    reviewedBy?: string;
  }>;
  trial: {
    status: "active" | "expired";
    startsAt: Date;
    endsAt: Date;
  };
  createdBy: string;
}

const companySchema = new Schema<CompanyDocument>(
  {
    name: { type: String, required: true, trim: true },
    domain: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },
    website: { type: String, required: true },
    businessDomain: { type: String, required: true },
    region: { type: String, required: true },
    regionLocation: {
      placeId: { type: String },
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
    },
    services: { type: [String], default: [] },
    cpvCodes: { type: [String], default: [] },
    members: {
      type: [
        {
          userId: { type: String, required: true },
          email: { type: String, required: true, lowercase: true },
          role: { type: String, enum: ["admin", "member"], required: true },
          joinedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    membershipRequests: {
      type: [
        {
          userId: { type: String, required: true },
          email: { type: String, required: true, lowercase: true },
          status: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending",
          },
          requestedAt: { type: Date, default: Date.now },
          reviewedAt: { type: Date },
          reviewedBy: { type: String },
        },
      ],
      default: [],
    },
    trial: {
      status: { type: String, enum: ["active", "expired"], default: "active" },
      startsAt: { type: Date, required: true },
      endsAt: { type: Date, required: true },
    },
    createdBy: { type: String, required: true },
  },
  { timestamps: true },
);

companySchema.index({ "membershipRequests.userId": 1 });

export const Company =
  (models.Company as Model<CompanyDocument>) ||
  model<CompanyDocument>("Company", companySchema);
