import { describe, expect, it } from "vitest";

import { quoteHash, normalizeQuote } from "../citations.ts";
import {
  EXTRACTION_SCHEMA_NAMES,
  EXTRACTION_SCHEMAS,
} from "./index.ts";

describe("EXTRACTION_SCHEMAS registry", () => {
  it("exports all seven schemas", () => {
    expect(EXTRACTION_SCHEMA_NAMES).toHaveLength(7);
    for (const name of EXTRACTION_SCHEMA_NAMES) {
      expect(EXTRACTION_SCHEMAS[name].name).toBe(name);
      expect(EXTRACTION_SCHEMAS[name].schemaVersion).toBe(1);
      expect(EXTRACTION_SCHEMAS[name].fieldNames.length).toBeGreaterThan(0);
    }
  });

  it("accepts an all-null output for every schema (§18.3: not-found is legal)", () => {
    for (const name of EXTRACTION_SCHEMA_NAMES) {
      const entry = EXTRACTION_SCHEMAS[name];
      const fields = Object.fromEntries(entry.fieldNames.map((f) => [f, null]));
      const parsed = entry.zod.safeParse({ fields, unresolved: entry.fieldNames });
      expect(parsed.success, `${name} all-null`).toBe(true);
    }
  });

  it("accepts a populated deadlines output and rejects a malformed one", () => {
    const entry = EXTRACTION_SCHEMAS.deadlines;
    const good = {
      fields: {
        submissionDeadline: {
          value: "2026-08-27T10:00:00+02:00",
          confidence: 0.95,
          citations: [{ chunkId: "abc", quote: "Die Angebotsfrist endet am 27.08.2026 um 10:00 Uhr." }],
        },
        questionDeadline: null,
        bindingPeriodEnd: null,
        bindingPeriodDays: { value: 60, confidence: 0.9, citations: [{ chunkId: null, quote: "Bindefrist: 60 Kalendertage" }] },
        openingDate: null,
        executionStart: null,
        executionEnd: null,
      },
      unresolved: ["questionDeadline", "bindingPeriodEnd", "openingDate", "executionStart", "executionEnd"],
    };
    expect(entry.zod.safeParse(good).success).toBe(true);

    const bad = {
      fields: { submissionDeadline: { value: "tomorrow", confidence: 1, citations: [] } },
      unresolved: [],
    };
    expect(entry.zod.safeParse(bad).success).toBe(false);
  });

  it("produces Gemini-compatible JSON schemas (bounded nesting, object roots)", () => {
    for (const name of EXTRACTION_SCHEMA_NAMES) {
      const json = EXTRACTION_SCHEMAS[name].jsonSchema;
      expect(json.type).toBe("object");
      const serialized = JSON.stringify(json);
      expect(serialized).not.toContain('"$ref"');
      // Guard against runaway nesting (JSON-schema wrapper objects count too;
      // fields → CitedValue → array items → object lands at ~13 braces).
      let depth = 0;
      let maxDepth = 0;
      for (const char of serialized) {
        if (char === "{") maxDepth = Math.max(maxDepth, ++depth);
        if (char === "}") depth--;
      }
      expect(maxDepth).toBeLessThanOrEqual(14);
    }
  });
});

describe("quote normalization", () => {
  it("hash is whitespace-insensitive", () => {
    expect(quoteHash("Die  Angebotsfrist\nendet")).toBe(quoteHash("Die Angebotsfrist endet"));
  });

  it("normalization collapses all whitespace runs", () => {
    expect(normalizeQuote("a\t b\n\nc ")).toBe("a b c");
  });
});
