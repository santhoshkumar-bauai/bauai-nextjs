import { describe, expect, it } from "vitest";

import {
  applyFieldmapPatch,
  applySensitivityRatchet,
  computeOpenQuestions,
  fillFieldSchema,
  fillPatchSchema,
  scoreIssues,
  summariseIssues,
  type FillField,
  type FillIssue,
} from "./fieldmap.ts";

const field = (overrides: Partial<FillField> = {}): FillField =>
  fillFieldSchema.parse({
    id: "company_name",
    page: 1,
    kind: "text",
    box: [100, 100, 300, 120],
    value: "Muster Bau GmbH",
    label: "Firmenname",
    ...overrides,
  });

describe("fillFieldSchema", () => {
  it("accepts numeric raw values (formatting is sidecar-side)", () => {
    const parsed = fillFieldSchema.parse({
      id: "revenue_2025",
      page: 1,
      kind: "text",
      box: [1, 2, 3, 4],
      value: 2450000,
      value_type: "eur",
    });
    expect(parsed.value).toBe(2450000);
  });

  it("rejects unknown kinds and malformed boxes", () => {
    expect(() => field({ kind: "scribble" as never })).toThrow();
    expect(() =>
      fillFieldSchema.parse({ id: "x", page: 1, kind: "text", box: [1, 2, 3] }),
    ).toThrow();
  });
});

describe("applyFieldmapPatch", () => {
  it("updates, removes and adds by id — a patch, never a rewrite", () => {
    const base = [field(), field({ id: "revenue_2025", label: "Umsatz" })];
    const patch = fillPatchSchema.parse({
      update: [{ id: "company_name", font_size: 8 }],
      remove: ["revenue_2025"],
      add: [
        {
          id: "date_field",
          page: 1,
          kind: "text",
          box: [10, 10, 60, 22],
          value: "2026-07-17",
          value_type: "date",
        },
      ],
    });
    const merged = applyFieldmapPatch(base, patch);
    const byId = new Map(merged.map((f) => [f.id, f]));
    expect(byId.get("company_name")?.font_size).toBe(8);
    expect(byId.get("company_name")?.value).toBe("Muster Bau GmbH"); // untouched
    expect(byId.has("revenue_2025")).toBe(false);
    expect(byId.get("date_field")?.value_type).toBe("date");
  });

  it("ignores updates for unknown ids instead of inventing fields", () => {
    const merged = applyFieldmapPatch(
      [field()],
      fillPatchSchema.parse({ update: [{ id: "ghost", value: "boo" }] }),
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("company_name");
  });
});

describe("applySensitivityRatchet", () => {
  it("forces sensitive + blanks model-invented values on signature/bank labels", () => {
    const { fields, heldBack } = applySensitivityRatchet(
      [
        field({ id: "sig", label: "Rechtsverbindliche Unterschrift", value: "Max M." }),
        field({ id: "iban_field", label: "IBAN", value: "DE00 1234" }),
        field(), // benign
      ],
      new Set(),
    );
    const byId = new Map(fields.map((f) => [f.id, f]));
    expect(byId.get("sig")?.sensitive).toBe(true);
    expect(byId.get("sig")?.value).toBe("");
    expect(byId.get("iban_field")?.value).toBe("");
    expect(byId.get("company_name")?.value).toBe("Muster Bau GmbH");
    expect(heldBack.sort()).toEqual(["iban_field", "sig"]);
  });

  it("keeps a sensitive value the USER supplied (id in the allowlist)", () => {
    const { fields, heldBack } = applySensitivityRatchet(
      [field({ id: "iban_field", label: "IBAN", value: "DE00 1234" })],
      new Set(["iban_field"]),
    );
    expect(fields[0].sensitive).toBe(true);
    expect(fields[0].value).toBe("DE00 1234");
    expect(heldBack).toEqual([]);
  });

  it("never un-flags: model-set sensitive stays sensitive", () => {
    const { fields } = applySensitivityRatchet(
      [field({ id: "plain", label: "Anmerkung", sensitive: true, value: "x" })],
      new Set(),
    );
    expect(fields[0].sensitive).toBe(true);
    expect(fields[0].value).toBe("");
  });
});

describe("computeOpenQuestions", () => {
  it("lists ALL empty text fields — required first, then optional, then sensitive", () => {
    const open = computeOpenQuestions([
      field({ id: "opt", value: "", label: "Telefonnummer" }),
      field({ id: "req", value: "", required: true }),
      field({ id: "sig", value: "", sensitive: true }),
      field({ id: "done", value: "filled", required: true }),
    ]);
    expect(open.map((question) => [question.fieldId, question.reason])).toEqual([
      ["req", "missing_required"],
      ["opt", "missing_optional"],
      ["sig", "sensitive"],
    ]);
  });

  it("carries the value_type hint for form input rendering", () => {
    const open = computeOpenQuestions([
      field({ id: "revenue", value: "", value_type: "eur" }),
    ]);
    expect(open[0].valueType).toBe("eur");
  });
});

describe("scoreIssues (verbatim policy from toolkit validate.py)", () => {
  const issue = (severity: FillIssue["severity"]): FillIssue => ({
    severity,
    code: "X",
    field_id: null,
    page: null,
    detail: "d",
  });

  it("any error is a hard zero", () => {
    expect(scoreIssues([issue("error"), issue("warning")])).toBe(0);
  });

  it("warnings cost 0.02 each, capped at 0.20; info is free", () => {
    expect(scoreIssues([])).toBe(1);
    expect(scoreIssues([issue("warning")])).toBe(0.98);
    expect(scoreIssues(Array.from({ length: 30 }, () => issue("warning")))).toBe(0.8);
    expect(scoreIssues([issue("info")])).toBe(1);
  });
});

describe("summariseIssues", () => {
  it("formats compactly and truncates", () => {
    const issues: FillIssue[] = Array.from({ length: 45 }, (_, i) => ({
      severity: "error",
      code: "OVERFLOW_X",
      field_id: `f${i}`,
      page: 2,
      detail: "spans too far",
    }));
    const text = summariseIssues(issues, 40);
    expect(text).toContain("[ERROR] OVERFLOW_X (p2, field=f0): spans too far");
    expect(text).toContain("... and 5 more");
  });
});
