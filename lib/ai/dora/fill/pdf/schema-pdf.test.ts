import { describe, expect, it } from "vitest";

import { PDF_FILL_DISCOVERY_JSON_SCHEMA, pdfFillDiscoverySchema } from "./schema-pdf";

/** Walk every node of the raw JSON Schema. */
function* walk(node: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child);
    return;
  }
  if (node && typeof node === "object") {
    yield node as Record<string, unknown>;
    for (const value of Object.values(node)) yield* walk(value);
  }
}

describe("PDF_FILL_DISCOVERY_JSON_SCHEMA", () => {
  it("contains no maxItems anywhere — Gemini rejects it as INVALID_ARGUMENT", () => {
    // Same constraint the Word schema documents. The 500 cap lives in Zod.
    for (const node of walk(PDF_FILL_DISCOVERY_JSON_SCHEMA)) {
      expect(node).not.toHaveProperty("maxItems");
    }
  });

  it("keeps nested numeric bounds, which probe P2.C confirmed are accepted", () => {
    const rect = PDF_FILL_DISCOVERY_JSON_SCHEMA.properties.fields.items.properties.rect;
    expect(rect.properties.x.minimum).toBe(0);
    expect(
      PDF_FILL_DISCOVERY_JSON_SCHEMA.properties.fields.items.properties.confidence.maximum,
    ).toBe(1);
  });

  it("forbids extra properties so the model cannot smuggle unvalidated geometry", () => {
    expect(PDF_FILL_DISCOVERY_JSON_SCHEMA.properties.fields.items.additionalProperties).toBe(false);
  });

  it("requires every field property, so nothing arrives implicitly undefined", () => {
    const items = PDF_FILL_DISCOVERY_JSON_SCHEMA.properties.fields.items;
    expect([...items.required].sort()).toEqual(Object.keys(items.properties).sort());
  });
});

describe("pdfFillDiscoverySchema", () => {
  const minimal = { kind: "acroform" as const, label: "Firmenname" };

  it("applies defaults for everything the model omits", () => {
    const parsed = pdfFillDiscoverySchema.parse({ fields: [minimal] });
    expect(parsed.fields[0]).toMatchObject({
      nodeId: "",
      description: "",
      required: false,
      sensitive: false,
      page: 0,
      anchorText: "",
      rect: null,
      value: null,
      confidence: 0,
      evidenceReferences: [],
      reason: "",
    });
  });

  it("still enforces the 500-field cap that the raw schema cannot express", () => {
    const over = { fields: Array.from({ length: 501 }, () => minimal) };
    expect(() => pdfFillDiscoverySchema.parse(over)).toThrow();
    const at = { fields: Array.from({ length: 500 }, () => minimal) };
    expect(pdfFillDiscoverySchema.parse(at).fields).toHaveLength(500);
  });

  it("rejects an unknown kind rather than defaulting it", () => {
    expect(() =>
      pdfFillDiscoverySchema.parse({ fields: [{ ...minimal, kind: "freehand" }] }),
    ).toThrow();
  });

  it("rejects a confidence outside 0..1", () => {
    expect(() =>
      pdfFillDiscoverySchema.parse({ fields: [{ ...minimal, confidence: 1.4 }] }),
    ).toThrow();
  });

  it("rejects a partial rect rather than filling in zeros", () => {
    expect(() =>
      pdfFillDiscoverySchema.parse({ fields: [{ ...minimal, rect: { x: 1, y: 2 } }] }),
    ).toThrow();
  });
});
