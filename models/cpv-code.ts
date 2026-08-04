import { Schema, model, models, type Model } from "mongoose";

export interface CpvCodeDocument {
  code: string;
  name: { en: string; de: string };
  division: string;
  hierarchyLevel: number;
  categories: string[];
  keywords: string[];
  source: string;
  sourceFile: string;
  translationSource: string;
  version: string;
}

const cpvCodeSchema = new Schema<CpvCodeDocument>(
  {
    code: { type: String, required: true, unique: true, index: true },
    name: {
      en: { type: String, required: true },
      de: { type: String, required: true },
    },
    division: { type: String, required: true, index: true },
    hierarchyLevel: { type: Number, required: true },
    categories: { type: [String], default: [], index: true },
    keywords: { type: [String], default: [] },
    source: { type: String, required: true },
    sourceFile: { type: String, required: true },
    translationSource: { type: String, required: true },
    version: { type: String, required: true },
  },
  { timestamps: true },
);

cpvCodeSchema.index({ "name.en": "text", "name.de": "text", keywords: "text" });
cpvCodeSchema.index({ categories: 1, hierarchyLevel: 1 });

export const CpvCode =
  (models.CpvCode as Model<CpvCodeDocument>) ||
  model<CpvCodeDocument>("CpvCode", cpvCodeSchema);
