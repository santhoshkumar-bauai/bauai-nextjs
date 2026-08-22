import type { GaebOzMask, GaebOzMaskPart } from "./types";

/**
 * OZ ("Ordnungszahl") composition. The OZ is the hierarchical position number
 * shown to estimators ("01.02.0010"). It is display-only in BAU AI — item
 * identity is the parser-assigned ordinal key — so a mask the parser cannot
 * fully interpret degrades to a plain dotted join instead of failing the file.
 */

/** Zero-pads numeric parts to the mask length; leaves alphanumerics alone. */
function formatPart(raw: string, part: GaebOzMaskPart | undefined): string {
  const value = raw.trim();
  if (!part || !part.numeric || !/^\d+$/.test(value)) return value;
  return value.padStart(part.length, "0");
}

/**
 * Composes the display OZ for a node from the RNoPart chain of its category
 * ancestors plus, for items, the item part and optional index.
 */
export function composeOz(input: {
  mask: GaebOzMask | null;
  categoryParts: string[];
  itemPart?: string | null;
  indexPart?: string | null;
}): string {
  const categoryMask = input.mask?.parts.filter((part) => part.kind === "category") ?? [];
  const itemMask = input.mask?.parts.find((part) => part.kind === "item");
  const indexMask = input.mask?.parts.find((part) => part.kind === "index");

  const segments = input.categoryParts
    .map((raw, level) => formatPart(raw, categoryMask[level]))
    .filter((segment) => segment.length > 0);

  if (input.itemPart) segments.push(formatPart(input.itemPart, itemMask));
  if (input.indexPart) segments.push(formatPart(input.indexPart, indexMask));

  return segments.join(".");
}
