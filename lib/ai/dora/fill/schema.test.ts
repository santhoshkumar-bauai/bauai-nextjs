import { describe, expect, it } from "vitest";

import { FILL_DISCOVERY_JSON_SCHEMA, fillDiscoverySchema } from "./schema.ts";

const field = {
  nodeId: "node-1",
  label: "Company name",
  description: "",
  required: true,
  sensitive: false,
  targetText: "{{COMPANY_NAME}}",
  value: "Example Construction Ltd",
  confidence: 1,
  evidenceReferences: [],
  reason: "Matched company profile.",
};

describe("fill discovery schemas", () => {
  it("keeps Gemini-incompatible array limits out of the provider schema", () => {
    expect(FILL_DISCOVERY_JSON_SCHEMA.properties.fields).not.toHaveProperty("maxItems");
  });

  it("still rejects more than 500 discovered fields after model output", () => {
    const result = fillDiscoverySchema.safeParse({
      fields: Array.from({ length: 501 }, (_, index) => ({
        ...field,
        nodeId: `node-${index}`,
      })),
    });

    expect(result.success).toBe(false);
  });
});
