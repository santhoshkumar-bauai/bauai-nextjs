/**
 * Runtime representation of `.agents/skills/adaptive-pdf-filling/SKILL.md`.
 * Keeping the instructions typed here lets LangGraph nodes and LangChain model
 * calls load the skill without relying on runtime filesystem access in Next.js.
 */
export const ADAPTIVE_PDF_SKILL = {
  name: "adaptive-pdf-filling",
  version: "1.0.0",
  sourceUrl: "https://www.claudeskills.org/docs/skills-cases/pdf",
  instructions: `Adaptive PDF filling skill:
- Inspect and classify every page before mapping; mixed strategies are allowed.
- Initial mapping and fill cover the complete document in one Sol/high plan.
- Models select supplied stable anchorId values; deterministic code owns coordinates and PDF writing.
- Preserve native AcroForms and validate field ids, options, inherited values, widgets, and appearances.
- OCR scanned pages at 300 DPI with German and English language support.
- Ground values in user or company evidence. Legal decisions require explicit confirmation; never auto-fill signatures.
- Validate the fully filled document before repair, then run a visual placement
  check: geometry measures ink against the box it wrote, so a value on the wrong
  row is self-consistent and invisible to it.
- Batch only failed placement/layout repairs, at most four pages per batch.
- Crop the region the ISSUE names, never an arbitrary field.
- A repair model receives the filled page (placement), a 400-DPI before/after crop
  of where the value landed (damage), and a 400-DPI strip of where its printed
  label is (destination), plus local issues, affected fields, measurements and
  the anchors of both regions.
- Reject arbitrary coordinates and cross-page mutations; a repair may re-select any
  anchor on its own page. Allow at most three attempts per region.
- Reassemble once from immutable source plus canonical field map and perform final full validation.
- Stream structured progress, never hidden reasoning or raw prompts.`,
} as const;

export type AdaptivePdfSkill = typeof ADAPTIVE_PDF_SKILL;
