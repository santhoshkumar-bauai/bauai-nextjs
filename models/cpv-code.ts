import { Schema, model, models, type Model } from "mongoose";

export interface CpvCodeDocument {
  code: string;
  name: { en: string; de: string };
  categories: string[];
  keywords: string[];
}

const cpvCodeSchema = new Schema<CpvCodeDocument>(
  {
    code: { type: String, required: true, unique: true, index: true },
    name: {
      en: { type: String, required: true },
      de: { type: String, required: true },
    },
    categories: { type: [String], default: [], index: true },
    keywords: { type: [String], default: [] },
  },
  { timestamps: true },
);

cpvCodeSchema.index({ "name.en": "text", "name.de": "text", keywords: "text" });

export const CpvCode = (models.CpvCode as Model<CpvCodeDocument>) ||
  model<CpvCodeDocument>("CpvCode", cpvCodeSchema);
