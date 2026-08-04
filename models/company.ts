import { Schema, model, models, type Model } from "mongoose";

export type CompanyMemberRole = "admin" | "member";

export interface CompanyDocument {
  name: string;
  domain: string;
  website: string;
  businessDomain: string;
  region: string;
  services: string[];
  cpvCodes: string[];
  members: Array<{
    userId: string;
    email: string;
    role: CompanyMemberRole;
    joinedAt: Date;
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
    domain: { type: String, required: true, unique: true, lowercase: true, index: true },
    website: { type: String, required: true },
    businessDomain: { type: String, required: true },
    region: { type: String, required: true },
    services: { type: [String], default: [] },
    cpvCodes: { type: [String], default: [] },
    members: {
      type: [{
        userId: { type: String, required: true },
        email: { type: String, required: true, lowercase: true },
        role: { type: String, enum: ["admin", "member"], required: true },
        joinedAt: { type: Date, default: Date.now },
      }],
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

export const Company = (models.Company as Model<CompanyDocument>) ||
  model<CompanyDocument>("Company", companySchema);
