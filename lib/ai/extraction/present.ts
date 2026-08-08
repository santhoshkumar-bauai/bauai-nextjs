/**
 * Pure presentation classifier for extraction field values: maps a
 * (schema, field, value) triple onto a small set of display kinds the UI
 * renders with locale-aware formatters. No React, no intl here — testable.
 */

export type PresentedValue =
  | { kind: "datetime"; iso: string }
  | { kind: "date"; iso: string }
  | { kind: "currency"; amount: number }
  | { kind: "percent"; value: number }
  | { kind: "days"; value: number }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "text"; value: string }
  | { kind: "stringList"; items: string[] }
  | { kind: "criteria"; items: Array<{ name: string; weightPercent: number | null }> }
  | {
      kind: "proofs";
      items: Array<{
        name: string;
        proofKind: string;
        mandatory: boolean | null;
        due: string | null;
      }>;
    }
  | { kind: "clauses"; items: Array<{ text: string; legalRef: string | null }> }
  | { kind: "unknown"; value: unknown };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T/;

export function presentFieldValue(fieldName: string, value: unknown): PresentedValue {
  if (typeof value === "boolean") return { kind: "boolean", value };

  if (typeof value === "string") {
    if (DATE_TIME.test(value)) return { kind: "datetime", iso: value };
    if (DATE_ONLY.test(value)) return { kind: "date", iso: value };
    return { kind: "text", value };
  }

  if (typeof value === "number") {
    if (/Eur$/.test(fieldName)) return { kind: "currency", amount: value };
    if (/Percent(PerDay|PerWeek)?$/.test(fieldName)) return { kind: "percent", value };
    if (/Days$/.test(fieldName)) return { kind: "days", value };
    return { kind: "number", value };
  }

  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === "string")) {
      return { kind: "stringList", items: value };
    }
    const first = value[0] as Record<string, unknown> | undefined;
    if (first && "weightPercent" in first) {
      return {
        kind: "criteria",
        items: value as Array<{ name: string; weightPercent: number | null }>,
      };
    }
    if (first && "kind" in first) {
      const items = (value as Array<Record<string, unknown>>).map((item) => ({
        name: String(item.name ?? ""),
        proofKind: String(item.kind ?? "other"),
        mandatory: (item.mandatory as boolean | null) ?? null,
        due: (item.due as string | null) ?? null,
      }));
      return { kind: "proofs", items };
    }
    if (first && "text" in first) {
      return {
        kind: "clauses",
        items: value as Array<{ text: string; legalRef: string | null }>,
      };
    }
    return { kind: "unknown", value };
  }

  return { kind: "unknown", value };
}
