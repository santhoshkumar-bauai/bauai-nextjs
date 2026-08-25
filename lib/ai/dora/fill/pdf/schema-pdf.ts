import { z } from "zod";

/**
 * The PDF discovery contract. Kept separate from ../schema.ts so the Word
 * contract cannot drift when this one changes.
 *
 * Same two-schema split as Word, and for the same reason: the raw JSON Schema
 * goes to the provider, Zod is the trust boundary on the way back. Array
 * bounds live ONLY in Zod — Gemini's generateContent rejects `maxItems` with
 * INVALID_ARGUMENT (see ../schema.ts). Probe P2.C confirmed nested numeric
 * `minimum`/`maximum` ARE accepted, so those stay.
 */

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

export const pdfFillDiscoverySchema = z.object({
  fields: z
    .array(
      z.object({
        /** `af:<n>` or `tl:<page>:<n>` from the manifest; "" for vision. */
        nodeId: z.string().max(160).default(""),
        kind: z.enum(["acroform", "overlay_text", "overlay_vision"]),
        label: z.string().min(1).max(200),
        description: z.string().max(500).default(""),
        required: z.boolean().default(false),
        sensitive: z.boolean().default(false),
        page: z.number().int().min(0).max(4_000).default(0),
        /**
         * For overlay_text: the LABEL preceding the blank, which must be
         * unique document-wide. Never the underscore run — probe P2.B showed
         * the model reaching for exactly that, and every blank is identical.
         */
        anchorText: z.string().max(300).default(""),
        /**
         * Advisory ONLY for acroform and overlay_text, where real geometry
         * comes from the manifest. Authoritative only for overlay_vision,
         * which can never auto-apply.
         */
        rect: rectSchema.nullable().default(null),
        value: z.string().max(20_000).nullable().default(null),
        confidence: z.number().min(0).max(1).default(0),
        evidenceReferences: z.array(z.string().max(300)).max(8).default([]),
        reason: z.string().max(500).default(""),
      }),
    )
    .max(500),
});

export type PdfFillDiscovery = z.infer<typeof pdfFillDiscoverySchema>;

export const PDF_FILL_DISCOVERY_JSON_SCHEMA = {
  type: "object",
  properties: {
    fields: {
      // NOTE: no `maxItems` here on purpose. Gemini's generateContent rejects
      // it as INVALID_ARGUMENT; the 500 cap is enforced by Zod above.
      type: "array",
      items: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description:
              "Exact manifest nodeId: 'af:<n>' for an AcroForm field, 'tl:<page>:<n>' for a text line. Empty only for overlay_vision.",
          },
          kind: {
            type: "string",
            enum: ["acroform", "overlay_text", "overlay_vision"],
          },
          label: { type: "string", description: "Human label for the field." },
          description: { type: "string" },
          required: { type: "boolean" },
          sensitive: { type: "boolean" },
          page: { type: "integer", minimum: 0, maximum: 4000 },
          anchorText: {
            type: "string",
            description:
              "overlay_text only: the label text preceding the blank, copied verbatim from the manifest line and unique in the whole document. Never the underscore run.",
          },
          // `rect` and `value` are `.nullable()` in Zod above, and the
          // provider schema has to say so. Listing them as required
          // non-nullable told the model both were mandatory, so on a field it
          // could not fill it invented geometry and a value rather than
          // returning null — silent fabrication in a document we then fill.
          // A type union is the portable spelling: Gemini accepts it in
          // responseJsonSchema, and OpenAI strict mode requires it, since
          // strict has no way to express "may be absent".
          rect: {
            type: ["object", "null"],
            properties: {
              x: { type: "number", minimum: 0 },
              y: { type: "number", minimum: 0 },
              width: { type: "number", minimum: 0 },
              height: { type: "number", minimum: 0 },
            },
            required: ["x", "y", "width", "height"],
            additionalProperties: false,
          },
          value: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceReferences: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: [
          "nodeId",
          "kind",
          "label",
          "description",
          "required",
          "sensitive",
          "page",
          "anchorText",
          "rect",
          "value",
          "confidence",
          "evidenceReferences",
          "reason",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["fields"],
  additionalProperties: false,
} as const;
