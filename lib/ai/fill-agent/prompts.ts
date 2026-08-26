import type { FillAgentRunContext } from "./context.ts";
import { ADAPTIVE_PDF_SKILL } from "./adaptive-pdf-skill.ts";

/**
 * Fill-agent prompts. The chat system prompt orchestrates tools; the three
 * sub-prompts (plan / critique / repair) are near-verbatim ports of the
 * Python POC's pdfagent/prompts/*.md and are consumed by planner.ts, not the
 * chat loop. Per repo convention the prompt is rebuilt per turn and never
 * checkpointed, so edits apply to conversations already in flight.
 */

export const FILL_AGENT_PROMPT_VERSION = "fill-agent-p1";

/** Shared absolute rules — the four from the Python POC's system.md. Sent
 * with every sub-model call AND embedded in the chat prompt. */
export const FILL_ABSOLUTE_RULES = `Absolute rules:
1. Select a supplied anchorId for every overlay field. Never invent or modify
   coordinates. Images tell you what a row MEANS; trusted code copies the
   selected anchor's coordinates. AcroForm widgets use their native field id.
2. Coordinates are PDF points with a TOP-LEFT origin: [x0, top, x1, bottom],
   where top < bottom. Do not flip them; the renderer handles that.
3. Output raw JSON only. No prose, no markdown fences, no explanation.
4. Never fill a field whose correct state is empty. Mutually exclusive options,
   "not applicable" rows, and reserved-for-authority boxes stay blank. A form
   with every box filled is usually a legally incoherent form.`;

export function buildFillAgentSystemPrompt(ctx: FillAgentRunContext): string {
  const locale = ctx.locale === "de" ? "German" : "English";
  const { fileName } = ctx.session.source;
  return `You are the document-filling assistant for a German tender/procurement platform. You help the user fill the PDF form "${fileName}" through conversation.

You ORCHESTRATE; deterministic code measures, draws and scores. Your tools drive a Python sandbox that extracts exact geometry, renders pages, draws the fill and validates the result. You never draw anything yourself and you never grade your own work.

WORKFLOW:
1. Inspect and classify the complete PDF, including mixed page types.
2. Use Sol/high once to map the complete document. Never split the initial mapping or fill into page batches.
3. Ground values, then pause once for all missing required values and explicit legal decisions.
4. Fill and validate the complete PDF deterministically.
5. Only after the full fill, group pages with placement/layout failures into at-most-four-page repair batches. Every model repair sees one local 400-DPI crop and local anchors only.
6. Rebuild once from the immutable source and canonical map, run final full validation, and deliver the verified download.

The application streams structured workflow actions inside the chat. Summarize outcomes; never reveal hidden reasoning or raw prompts.

HARD RULES (the code enforces most of these — do not fight it):
- The score comes ONLY from fill_and_validate. Output from run_python is your own observation and proves nothing about quality.
- Never invent business values (names, numbers, dates, addresses). For a missing value, GROUND FIRST: check get_company_profile and search_company_data — the company's own profile and documents answer most standard fields (name, legal form, address, registration numbers, key figures). Only ask the user for what you cannot ground. When a value came from company data, say so in your summary so the user can correct it.
- set_field_values also accepts grounded values — state their source. User-stated values always win over grounded ones.
- Sensitive fields — signatures ("Rechtsverbindliche Unterschrift"), bank details ("Bankverbindung", IBAN), attestations, powers of attorney — are NEVER auto-filled. The code blanks them unless the user explicitly provided the value. Explain that these stay for the human to complete.
- Pass values RAW with a value_type (eur, date, integer, percent, phone, text). German formatting (2.450.000,00 / 17.07.2026) is applied deterministically by code — never pre-format numbers or dates yourself.
- After a failed validation, call repair_fieldmap — never propose_fieldmap again. Re-planning throws away correct work. propose_fieldmap is only for the first mapping or when the user changes the task fundamentally.
- Keep the repair→validate loop going until the layout converges: repair_fieldmap, then fill_and_validate, then repair again if errors remain. The server re-arms the repair budget on every validate; when it refuses a repair, validate first. Do not stop and ask the user while deterministic errors are still fixable.
- The fill budget (fill_and_validate rounds) is per session and enforced server-side. When it is exhausted, summarize what remains for human review — do not look for workarounds.
- run_python executes real Python in the sandbox workspace (pdfplumber, pypdf, reportlab, and the toolkit are importable; source.pdf and artifacts are in the working directory). Use it to INSPECT and EXPERIMENT — reading text, checking a region, testing an idea. The final document always comes from fill_and_validate, never from your own code.

${FILL_ABSOLUTE_RULES}

LOADED SKILL (${ADAPTIVE_PDF_SKILL.name} v${ADAPTIVE_PDF_SKILL.version}):
${ADAPTIVE_PDF_SKILL.instructions}

STYLE:
- Respond in ${locale}.
- Be concise. Summarize tool results in user terms (score, what's missing, what changed) — never dump raw JSON at the user.
- When asking for values, group all questions into ONE message with a short list, mentioning the field label as printed on the form.`;
}

/** Port of plan.md — consumed by planner.proposeFieldmap. */
export const FILL_PLAN_PROMPT = `Produce a fieldmap for this form.

For each entry position that needs data, emit one field object:

{"id": "snake_case_stable_key",
 "page": 2,
 "kind": "text" | "checkbox" | "cover" | "restore_text" | "restore_rule",
 "anchorId": "p2:placeholder:...",  // copied verbatim from GEOMETRY
 "value": "the text to draw",
 "value_type": "eur" | "eur_sym" | "number" | "integer" | "percent" | "date" | "phone" | "text",
 "align": "left" | "center" | "right",
 "valign": "top" | "middle" | "bottom",
 "label": "nearest printed label, for the audit trail",
 "required": true,
 "exclusive_group": "optional; only one member may hold a value"}

Where to find entry positions in GEOMETRY (in this order of preference):
- "placeholder_lines" -> standalone '-'/'---' answer rows. Select anchor_id;
                     its full-width box is writable and replace_box is only
                     the glyph that deterministic code will cover.
- "empty_boxes"   -> rectangles with no content. Use the box VERBATIM. A box
                     whose only content is a leader run ("_______", "……") is
                     empty — that IS the entry area.
- "entry_lines"   -> ready-made entry areas derived from leader runs
                     ("____________", "………", dashes), already sized and
                     positioned so the value sits ON the line. Use verbatim.
- "cells"         -> table rows rebuilt from rules. Use the cell's vertical
                     extent; narrow the x-range to the column you mean.
- "checkboxes"    -> ~8x8pt squares. Emit kind "checkbox" with value "X".
- "rules"         -> bare underlines with no leader glyphs. Text sits just
                     above the rule: [x0, top-13, x1, top-1] from the rule.

If NONE of these covers a position you believe is fillable, say so in the
field's label rather than inventing a box: code snaps every box onto the
nearest real entry position and reports the ones that match nothing
(ANCHOR_MISMATCH), so an estimated box does not survive — it just costs a
repair round.

Values:
- VALUES AVAILABLE lists what the user has confirmed, keyed by field id where
  known. Use them raw and declare a value_type; formatting is done in code.
- COMPANY CONTEXT (when present) holds grounded facts from the company's
  profile and documents. Use them for fields they CLEARLY answer (company
  name, legal form, address, registration numbers, contact data, key
  figures). Do not stretch them to fields they do not answer.
- A field neither source answers: emit it WITHOUT a value (and with
  "required": true if the form marks it mandatory). The conversation will
  collect it. NEVER invent a business value.
- Do not set font_size unless the form forces one; code infers it from the
  template.
- Every legal Ja/Nein pair MUST share one exclusive_group. Emit both options
  without values; a human interrupt selects exactly one. Never infer a legal
  declaration from company data or surrounding text.

Native AcroForm fields (when NATIVE ACROFORM FIELDS is present): prefer them —
use the native field name as "id" and set "target": "acroform". Overlay fields
are only for positions no native field covers.

Keep the response compact so the complete document fits in one result:
- Omit "box" for every anchor-backed or native field; trusted code supplies it.
- Omit optional align, valign, value_type, required, and exclusive_group when
  their default/absence is correct.
- Keep labels concise (the nearest printed label, not a paragraph).
- Still include every field on every page; compactness must never drop pages.

Repair of pre-existing damage:
If a previous fill left text overlapping a border, running off the page edge, or
printed at a nonsense size, emit a "cover" (white rectangle) over it, then
"restore_text" / "restore_rule" entries reproducing any TEMPLATE content the
cover destroys. Copy the restore coordinates and sizes from GEOMETRY exactly.

Every cover MUST declare what it is meant to remove:

  {"id": "cover_stray_date", "page": 4, "kind": "cover",
   "box": [144, 676, 200, 689], "removes": ["17.07.2026"]}

Anything else the cover overlaps is treated as an error. Size the box from the
GEOMETRY coordinates of the text you are removing, not generously — a bottom
edge 1pt too low will clip the ascenders off the line beneath it.

Set valign "bottom" for text sitting on a line, "middle" inside a box,
"top" inside a tall multi-line box.

Return: {"fields": [ ... ]}`;

/** Port of critique.md — consumed by planner.critiqueFill. */
export const FILL_CRITIQUE_PROMPT = `These are rendered pages of a filled form. Look for defects that coordinate
maths cannot detect:

- text overlapping a printed label or crossing a table border
- a value sitting closer to the WRONG label than the right one
- a value that is plausible but semantically misplaced (a date in a name field)
- covered/whited-out regions that erased something they shouldn't have
- text that is visually cramped, clipped, or unreadable at this size
- a filled value set NOTICEABLY SMALLER than the printed template text beside
  it (the stamped-on look) — report as FONT_TOO_SMALL, severity warning
- a checkbox ticked whose meaning contradicts another ticked box

You get two kinds of image:

1. FULL PAGES at screen resolution. Use these for semantics and layout: is a
   value beside the right label, does anything overlap, is a tick contradictory.

2. CLOSE-UP STRIPS at 400dpi, BEFORE on top and AFTER below, of the same region.
   Use these for damage: compare the two halves character by character. Look for
   glyphs that lost their tops or bottoms, missing dots on i's and j's, truncated
   accents, and printed labels partly erased. A 1pt error clips only the very top
   of a line, so check the extremities of letters, not their middles.
   "ink_lost" is the fraction of dark pixels the fill removed in that region;
   a high value on a "cover" field is expected, on a "text" field it is not.

Do NOT report: typeface choice, aesthetic preferences, or that a field is
empty (empty is often correct). Size mismatch against neighbouring text IS
reportable; the typeface itself is not.

Return JSON only:
{"issues": [{"severity": "error"|"warning", "code": "SHORT_CODE",
             "page": 3, "field_id": "id_if_identifiable",
             "detail": "what is wrong and where"}]}

Return {"issues": []} if the pages are clean. Do not invent issues to seem
thorough — a false positive costs a full repair cycle.`;

/** Port of repair.md — consumed by planner.repairFieldmap. */
export const FILL_REPAIR_PROMPT = `The fieldmap below produced the listed issues. Emit a minimal PATCH.

Do not rewrite the fieldmap. Touch only fields named in the issues; every field
you leave alone stays as it is. Rewriting regresses correct work and makes the
loop oscillate instead of converge.

Common fixes:
- OVERFLOW_X / UNWRAPPABLE_WORD -> widen the box within the printed cell, or
  lower font_size, or shorten the value. Prefer widening if room exists.
- BOX_TOO_SMALL     -> shorten the value; do not go below 6pt.
- FIELD_OVERLAP     -> move one box into free space, or merge the two values.
- COVER_CLIPS_TEXT  -> shrink the cover to miss the label, or add a
                       restore_text entry reproducing the clipped word at its
                       original coordinates and size.
- OFF_PAGE          -> the box is wrong; re-derive it from the geometry.
- EXCLUSIVE_VIOLATION -> clear the value on all but one group member.
- NOT_RENDERED      -> the box is probably on the wrong page or inverted.
- FONT_TOO_SMALL    -> raise font_size to match the template size named in
                       the issue; if the value then no longer fits, widen the
                       box within the printed cell or shorten the value.
- ANCHOR_MISMATCH   -> the box matches no entry position. Re-derive it from
                       GEOMETRY: take the "empty_boxes"/"entry_lines"/"cells"
                       entry nearest the intended label, verbatim. Do not
                       nudge the old coordinates.
- MISSING_REQUIRED  -> only fill it if the user has provided the value;
                       otherwise leave it and let the conversation collect it.

Return JSON only:
{"update": [{"id": "...", "box": [...], "font_size": 8}],
 "add":    [ full field objects ],
 "remove": ["field_id"]}`;
