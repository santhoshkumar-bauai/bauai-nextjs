import { z } from "zod";

import { SENSITIVE } from "../dora/fill/sensitive.ts";

/**
 * The fieldmap: the durable artifact of a fill session (the Python POC's
 * product insight — once a template's fieldmap is right, refilling it is a
 * deterministic replay with no LLM).
 *
 * JSON keys are snake_case ON PURPOSE: they are the wire contract with the
 * Python toolkit in docker/fill-sandbox, which owns fill/validate. Converting
 * to camelCase at this boundary would mean two names for every concept and a
 * translation layer to get wrong. Identifiers around the data stay English
 * camelCase per repo convention.
 *
 * COORDINATES: PDF points, TOP-LEFT origin, [x0, top, x1, bottom] — the
 * sidecar's (pdfplumber) convention. The Node side never computes, converts
 * or invents a coordinate; it only carries them between model and sandbox.
 * (The monolith's pdf-lib space in lib/ai/dora/fill/types.ts is bottom-left —
 * do not mix the two.)
 */

export const FILL_FIELD_KINDS = [
  "text",
  "checkbox",
  "cover",
  "restore_text",
  "restore_rule",
] as const;

export const FILL_VALUE_TYPES = [
  "eur",
  "eur_sym",
  "number",
  "integer",
  "percent",
  "date",
  "phone",
  "text",
] as const;

export const fillFieldSchema = z.object({
  id: z.string().min(1).max(80),
  page: z.number().int().min(1),
  kind: z.enum(FILL_FIELD_KINDS),
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Raw value; German formatting happens sidecar-side via value_type. */
  value: z.union([z.string(), z.number()]).optional(),
  value_type: z.enum(FILL_VALUE_TYPES).optional(),
  font_size: z.number().positive().optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  valign: z.enum(["top", "middle", "bottom"]).optional(),
  label: z.string().max(300).default(""),
  /** "acroform" routes the value into the native field named by `id`. */
  target: z.literal("acroform").optional(),
  /** Covers must declare the template text they remove (COVER_CLIPS_TEXT). */
  removes: z.array(z.string()).optional(),
  exclusive_group: z.string().optional(),
  style_group: z.string().optional(),
  required: z.boolean().optional(),
  sensitive: z.boolean().optional(),
});

export type FillField = z.infer<typeof fillFieldSchema>;

export const fillFieldmapResponseSchema = z.object({
  fields: z.array(fillFieldSchema).max(400),
});

/** Repair output: a PATCH, never a rewrite (anti-oscillation invariant). */
export const fillPatchSchema = z.object({
  update: z
    .array(fillFieldSchema.partial().extend({ id: z.string().min(1) }))
    .default([]),
  add: z.array(fillFieldSchema).default([]),
  remove: z.array(z.string()).default([]),
});

export type FillPatch = z.infer<typeof fillPatchSchema>;

export interface FillIssue {
  severity: "error" | "warning" | "info";
  code: string;
  field_id: string | null;
  page: number | null;
  detail: string;
}

export const fillIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]).default("warning"),
  code: z.string().max(60).default("VISUAL"),
  field_id: z.string().nullable().default(null),
  page: z.number().int().nullable().default(null),
  detail: z.string().max(1000),
});

export const critiqueResponseSchema = z.object({
  issues: z.array(fillIssueSchema).max(60).default([]),
});

/** Patch merge, ported from node_repair: update/remove/add against an
 * id-keyed map, so a repair can only touch named fields. */
export function applyFieldmapPatch(fieldmap: FillField[], patch: FillPatch): FillField[] {
  const byId = new Map(fieldmap.map((f) => [f.id, { ...f }]));
  for (const update of patch.update) {
    const existing = byId.get(update.id);
    if (existing) byId.set(update.id, { ...existing, ...update });
  }
  for (const id of patch.remove) byId.delete(id);
  for (const added of patch.add) byId.set(added.id, added);
  return [...byId.values()];
}

/**
 * One-way sensitivity ratchet (same contract as the Dora fill resolvers):
 * a field whose label/id reads as signature/banking/attestation is forced
 * `sensitive: true`, and its value is BLANKED unless the user themself
 * supplied it in chat. The model can add sensitivity, never remove it.
 */
export function applySensitivityRatchet(
  fieldmap: FillField[],
  userProvidedFieldIds: ReadonlySet<string>,
): { fields: FillField[]; heldBack: string[] } {
  const heldBack: string[] = [];
  const fields = fieldmap.map((field) => {
    const flagged =
      field.sensitive === true || SENSITIVE.test(`${field.label} ${field.id}`);
    if (!flagged) return field;
    const keepValue = userProvidedFieldIds.has(field.id);
    if (!keepValue && field.value != null && String(field.value) !== "") {
      heldBack.push(field.id);
    }
    return {
      ...field,
      sensitive: true,
      ...(keepValue ? {} : { value: "" }),
    };
  });
  return { fields, heldBack };
}

export interface OpenQuestion {
  fieldId: string;
  label: string;
  /** Hint for input rendering in the values form. */
  valueType?: (typeof FILL_VALUE_TYPES)[number];
  reason: "missing_required" | "missing_optional" | "sensitive";
}

const MAX_OPEN_QUESTIONS = 60;

/**
 * Fields the conversation still has to resolve. ALL empty text fields are
 * listed (not just required ones) — they drive the values form the user can
 * fill or skip; only `missing_required` blocks a fill run.
 */
export function computeOpenQuestions(fieldmap: FillField[]): OpenQuestion[] {
  const open: OpenQuestion[] = [];
  for (const field of fieldmap) {
    const empty = field.value == null || String(field.value) === "";
    if (!empty) continue;
    if (field.sensitive) {
      open.push({
        fieldId: field.id,
        label: field.label || field.id,
        valueType: field.value_type,
        reason: "sensitive",
      });
    } else if (field.kind === "text") {
      open.push({
        fieldId: field.id,
        label: field.label || field.id,
        valueType: field.value_type,
        reason: field.required ? "missing_required" : "missing_optional",
      });
    }
  }
  // Required first so a capped list never hides a blocker.
  const rank = { missing_required: 0, missing_optional: 1, sensitive: 2 };
  return open
    .sort((a, b) => rank[a.reason] - rank[b.reason])
    .slice(0, MAX_OPEN_QUESTIONS);
}

/** Scoring policy, ported verbatim from toolkit validate.py: errors are a
 * hard gate, warnings a small capped penalty, info never scores. Used only
 * for the critique add-only re-score; fill scores come from /run/validate. */
export function scoreIssues(issues: FillIssue[]): number {
  if (issues.some((issue) => issue.severity === "error")) return 0;
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const penalty = Math.min(warnings * 0.02, 0.2);
  return Math.round((1 - penalty) * 10_000) / 10_000;
}

/** Compact issue feedback for the repair prompt (port of summarise()). */
export function summariseIssues(issues: FillIssue[], limit = 40): string {
  if (issues.length === 0) return "No issues.";
  const lines = issues.slice(0, limit).map((issue) => {
    const loc = issue.page ? `p${issue.page}` : "-";
    return `[${issue.severity.toUpperCase()}] ${issue.code} (${loc}, field=${issue.field_id}): ${issue.detail}`;
  });
  if (issues.length > limit) lines.push(`... and ${issues.length - limit} more`);
  return lines.join("\n");
}
