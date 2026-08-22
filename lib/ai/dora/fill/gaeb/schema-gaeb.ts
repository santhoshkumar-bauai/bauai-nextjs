import { z } from "zod";

/**
 * GAEB fill schemas — the same two-schema discipline as ../schema.ts and
 * ../pdf/schema-pdf.ts: a hand-written JSON Schema goes to the provider
 * (Gemini rejects validation keywords like maxItems with INVALID_ARGUMENT —
 * see the precedent documented in ../schema.ts), and Zod is the trust
 * boundary on the way back, where the real bounds live.
 */

/* ------------------------------ tender context --------------------------- */

export const gaebContextSchema = z.object({
  projectType: z.array(z.string().max(60)).max(5).default([]),
  building: z.string().max(120).nullable().default(null),
  existingBuilding: z.boolean().nullable().default(null),
  occupiedDuringConstruction: z.boolean().nullable().default(null),
  region: z.string().max(120).nullable().default(null),
  siteConditions: z.array(z.string().max(200)).max(10).default([]),
  riskFactors: z
    .array(
      z.object({
        factor: z.string().min(1).max(120),
        pricingImpact: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(8)
    .default([]),
  summary: z.string().max(1500).default(""),
});

export const GAEB_CONTEXT_JSON_SCHEMA = {
  type: "object",
  properties: {
    projectType: { type: "array", items: { type: "string" } },
    building: { type: "string", nullable: true },
    existingBuilding: { type: "boolean", nullable: true },
    occupiedDuringConstruction: { type: "boolean", nullable: true },
    region: { type: "string", nullable: true },
    siteConditions: { type: "array", items: { type: "string" } },
    riskFactors: {
      type: "array",
      items: {
        type: "object",
        properties: {
          factor: { type: "string" },
          pricingImpact: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["factor", "pricingImpact"],
      },
    },
    summary: { type: "string" },
  },
  required: ["summary"],
} as const;

/* ------------------------------ classification --------------------------- */

export const gaebClassifyBatchSchema = z.object({
  items: z
    .array(
      z.object({
        itemKey: z.string().min(1).max(40),
        trade: z.string().min(1).max(120),
        workCategory: z.string().max(120).default(""),
        attributes: z.array(z.string().max(80)).max(8).default([]),
        productMentions: z.array(z.string().max(120)).max(4).default([]),
      }),
    )
    .max(60),
});

export const GAEB_CLASSIFY_BATCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemKey: { type: "string" },
          trade: { type: "string" },
          workCategory: { type: "string" },
          attributes: { type: "array", items: { type: "string" } },
          productMentions: { type: "array", items: { type: "string" } },
        },
        required: ["itemKey", "trade"],
      },
    },
  },
  required: ["items"],
} as const;

/* --------------------------------- pricing ------------------------------- */

export const gaebPricingBatchSchema = z.object({
  items: z
    .array(
      z.object({
        itemKey: z.string().min(1).max(40),
        unitPrice: z.number().finite().min(0).max(10_000_000).nullable(),
        rangeLow: z.number().finite().min(0).max(10_000_000).default(0),
        rangeHigh: z.number().finite().min(0).max(10_000_000).default(0),
        confidence: z.number().min(0).max(1).default(0),
        assumptions: z.array(z.string().max(300)).max(5).default([]),
        risks: z.array(z.string().max(300)).max(5).default([]),
        evidenceReferences: z.array(z.string().max(300)).max(4).default([]),
        reason: z.string().max(400).default(""),
      }),
    )
    .max(60),
});

export const GAEB_PRICING_BATCH_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          itemKey: { type: "string" },
          unitPrice: { type: "number", nullable: true },
          rangeLow: { type: "number" },
          rangeHigh: { type: "number" },
          confidence: { type: "number" },
          assumptions: { type: "array", items: { type: "string" } },
          risks: { type: "array", items: { type: "string" } },
          evidenceReferences: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["itemKey", "unitPrice", "confidence"],
      },
    },
  },
  required: ["items"],
} as const;

/* ------------------------- web price extraction -------------------------- */

export const gaebWebPriceSchema = z.object({
  findings: z
    .array(
      z.object({
        product: z.string().min(1).max(160),
        unitPrice: z.number().finite().min(0).max(10_000_000).nullable().default(null),
        unit: z.string().max(20).default(""),
        currency: z.string().max(8).default("EUR"),
        sourceUrl: z.string().max(500).default(""),
        sourceTitle: z.string().max(200).default(""),
        note: z.string().max(300).default(""),
      }),
    )
    .max(120),
});

export const GAEB_WEB_PRICE_JSON_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          product: { type: "string" },
          unitPrice: { type: "number", nullable: true },
          unit: { type: "string" },
          currency: { type: "string" },
          sourceUrl: { type: "string" },
          sourceTitle: { type: "string" },
          note: { type: "string" },
        },
        required: ["product"],
      },
    },
  },
  required: ["findings"],
} as const;
