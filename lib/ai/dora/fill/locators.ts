import type { DocumentFillLocator } from "./types";

/**
 * Can this target be written without a human confirming the position?
 *
 * Every strategy except `pdf_overlay_vision` is deterministically verifiable:
 * a form key, a content-control tag, an AcroForm field name, or a text anchor
 * that must occur exactly once. Vision geometry on a scanned page has no such
 * check — nothing proves the rect is empty, on-page, or clear of existing ink.
 *
 * This is one of three independent gates on that, mirroring the posture where
 * generate.ts re-filters what the route already filtered:
 *   1. resolve-pdf.ts clamps vision fields below `ready`;
 *   2. patchFillFields refuses to promote them when the user types a value;
 *   3. generate.ts drops them and pdf-fill.ts throws if one still arrives.
 */
export function canAutoApply(locator: DocumentFillLocator | null): boolean {
  if (!locator) return false;
  return locator.strategy !== "pdf_overlay_vision";
}

/**
 * Identity of the thing a locator writes to. Two instructions sharing a key
 * would fight over one target, so the fill engines reject duplicates up front.
 *
 * Note this is deliberately NOT the field id: two discovered fields can point
 * at the same AcroForm field or the same text anchor, and that is the collision
 * worth catching.
 */
export function locatorKey(locator: DocumentFillLocator): string {
  switch (locator.strategy) {
    case "form_key":
      return `form:${locator.formKey}`;
    case "unique_text":
      return `text:${locator.searchText}`;
    case "pdf_acroform":
      return `af:${locator.fieldName}`;
    case "pdf_overlay_text":
      return `ovt:${locator.page}:${locator.anchorText}`;
    case "pdf_overlay_vision":
      return `vis:${locator.page}:${Math.round(locator.rect.x)}:${Math.round(locator.rect.y)}`;
  }
}
