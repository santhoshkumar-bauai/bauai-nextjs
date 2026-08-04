import { Schema, model, models, type Model, type Types } from "mongoose";

export interface AccountProfileDocument {
  userId: string;
  email: string;
  companyId: Types.ObjectId;
  role: "admin" | "member";
  membershipStatus: "active" | "pending" | "rejected";
  onboardingCompleted: boolean;
  locale: "en" | "de";
  trialStartsAt: Date;
  trialEndsAt: Date;
}

const accountProfileSchema = new Schema<AccountProfileDocument>(
  {
    userId: { type: String, required: true, unique: true, index: true },
    email: { type: String, required: true, lowercase: true },
    companyId: { type: Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    role: { type: String, enum: ["admin", "member"], required: true },
    membershipStatus: { type: String, enum: ["active", "pending", "rejected"], default: "active", index: true },
    onboardingCompleted: { type: Boolean, default: false },
    locale: { type: String, enum: ["en", "de"], default: "en" },
    trialStartsAt: { type: Date, required: true },
    trialEndsAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export const AccountProfile =
  (models.AccountProfile as Model<AccountProfileDocument>) ||
  model<AccountProfileDocument>("AccountProfile", accountProfileSchema);
