import { describe, expect, it } from "vitest";

import { adaptJsonSchema, dialectForProvider, toProviderSafeJsonSchema } from "./json-schema.ts";

/**
 * Drill-anywhere view of an adapted schema. The adapter's return type is
 * deliberately opaque (it is whatever the dialect emits), and these tests
 * assert on nested keywords — this keeps that reachable without `any`.
 */
interface SchemaView {
  [key: string]: SchemaView;
}

describe("gemini dialect", () => {
  it("drops validation-only keywords its response-schema validator rejects", () => {
    expect(
      adaptJsonSchema(
        {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: 400 },
            values: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
          },
          required: ["text", "values"],
        },
        "gemini",
      ),
    ).toEqual({
      type: "object",
      properties: {
        text: { type: "string" },
        values: { type: "array", items: { type: "string" } },
      },
      required: ["text", "values"],
    });
  });

  it("keeps the legacy export behaving identically", () => {
    const schema = { type: "object", properties: { a: { type: "string", maxLength: 2 } } };
    expect(toProviderSafeJsonSchema(schema)).toEqual(adaptJsonSchema(schema, "gemini"));
  });
});

describe("openai-strict dialect", () => {
  it("forces every property into required and widens the newly-required ones", () => {
    // The rule strict mode enforces: "required ... to be an array including
    // every key in properties". `b` was optional in the product's model, so
    // it must become nullable as it is forced in — otherwise the schema tells
    // the model `b` is mandatory and the model invents one.
    expect(
      adaptJsonSchema(
        {
          type: "object",
          properties: { a: { type: "string" }, b: { type: "string" } },
          required: ["a"],
        },
        "openai-strict",
      ),
    ).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" }, b: { type: ["string", "null"] } },
      required: ["a", "b"],
    });
  });

  it("rewrites OpenAPI 3.0 `nullable` as a type union", () => {
    expect(
      adaptJsonSchema(
        {
          type: "object",
          properties: { note: { type: "string", nullable: true } },
          required: ["note"],
        },
        "openai-strict",
      ),
    ).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { note: { type: ["string", "null"] } },
      required: ["note"],
    });
  });

  it("widens an optional object-typed property through anyOf", () => {
    const adapted = adaptJsonSchema(
      {
        type: "object",
        properties: {
          rect: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
        },
        required: [],
      },
      "openai-strict",
    );
    expect((adapted.properties as Record<string, { type?: unknown }>).rect.type).toEqual([
      "object",
      "null",
    ]);
  });

  it("recurses through items, anyOf and $defs", () => {
    const adapted = adaptJsonSchema(
      {
        $defs: {
          Row: { type: "object", properties: { a: { type: "string" } }, required: [] },
        },
        type: "object",
        properties: {
          rows: { type: "array", items: { $ref: "#/$defs/Row" } },
          either: { anyOf: [{ type: "object", properties: { z: { type: "string" } }, required: [] }] },
        },
        required: ["rows", "either"],
      },
      "openai-strict",
    ) as unknown as SchemaView;

    expect(adapted.$defs.Row.required).toEqual(["a"]);
    expect(adapted.$defs.Row.additionalProperties).toBe(false);
    expect(adapted.properties.either.anyOf[0].required).toEqual(["z"]);
  });

  it("keeps bounds keywords by default and strips them on request", () => {
    const schema = { type: "object", properties: { n: { type: "number", maximum: 1 } }, required: ["n"] };
    expect(adaptJsonSchema(schema, "openai-strict")).toMatchObject({
      properties: { n: { maximum: 1 } },
    });
    expect(
      adaptJsonSchema(schema, "openai-strict", { stripBounds: true }),
    ).toMatchObject({ properties: { n: { type: "number" } } });
    expect(
      (adaptJsonSchema(schema, "openai-strict", { stripBounds: true }).properties as unknown as SchemaView).n,
    ).not.toHaveProperty("maximum");
  });

  it("is idempotent", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string", nullable: true } },
      required: ["a"],
    };
    const once = adaptJsonSchema(schema, "openai-strict");
    expect(adaptJsonSchema(once, "openai-strict")).toEqual(once);
  });

  it("does not re-widen a property that is already nullable", () => {
    const adapted = adaptJsonSchema(
      { type: "object", properties: { a: { type: ["string", "null"] } }, required: [] },
      "openai-strict",
    );
    expect((adapted.properties as unknown as SchemaView).a.type).toEqual(["string", "null"]);
  });
});

describe("dialectForProvider", () => {
  it("sends gemini to its own subset and everything else to strict", () => {
    expect(dialectForProvider("gemini")).toBe("gemini");
    expect(dialectForProvider("azure")).toBe("openai-strict");
    expect(dialectForProvider("openai")).toBe("openai-strict");
    // An unknown provider gets the stricter dialect: over-constraining a
    // request fails loudly, under-constraining it fabricates data.
    expect(dialectForProvider("mistral")).toBe("openai-strict");
  });
});

describe("real schemas from the codebase", () => {
  it("completes the partial `required` in the GAEB pricing schema", async () => {
    const { GAEB_PRICING_BATCH_JSON_SCHEMA } = await import(
      "../dora/fill/gaeb/schema-gaeb.ts"
    );
    const adapted = adaptJsonSchema(GAEB_PRICING_BATCH_JSON_SCHEMA, "openai-strict") as unknown as SchemaView;
    const item = adapted.properties.items.items;
    expect(item.required).toEqual(Object.keys(item.properties));
    expect(item.additionalProperties).toBe(false);
    // The hand-written schema uses OpenAPI `nullable`; none may survive.
    expect(JSON.stringify(adapted)).not.toContain('"nullable"');
  });

  it("keeps the PDF fill schema's nullable fields nullable", async () => {
    const { PDF_FILL_DISCOVERY_JSON_SCHEMA } = await import(
      "../dora/fill/pdf/schema-pdf.ts"
    );
    const adapted = adaptJsonSchema(PDF_FILL_DISCOVERY_JSON_SCHEMA, "openai-strict") as unknown as SchemaView;
    const field = adapted.properties.fields.items;
    expect(field.required).toEqual(Object.keys(field.properties));
    // `value` and `rect` are nullable in Zod; strict mode must be told, or the
    // model is forced to invent a value for an unfilled field.
    const nullable = (name: string) => {
      const type = field.properties[name].type;
      return Array.isArray(type) ? type.includes("null") : Boolean(field.properties[name].anyOf);
    };
    expect(nullable("value")).toBe(true);
    expect(nullable("rect")).toBe(true);
  });
});
