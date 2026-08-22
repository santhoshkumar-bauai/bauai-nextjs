import type { GaebDocument, GaebItem } from "./types";

/**
 * Structured plain-text projection of a parsed bill of quantities — what
 * Dora's chat/brief (and later Clara's retrieval) read instead of raw GAEB
 * markup. Kurztext only per position: the full Langtext of a 500-position LV
 * would dwarf any context budget while adding little for conversation.
 */

const PRELIMINARY_CAP = 8_000;

const MARKER_LABELS: Record<GaebItem["markers"][number], string> = {
  provisional: "Bedarfsposition",
  alternative: "Alternativposition",
  lump_sum: "Pauschale",
  hourly: "Stundenlohn",
  surcharge: "Zulage",
  free_quantity: "Freie Menge",
};

export function projectGaebToText(document: GaebDocument): string {
  const meta = document.meta;
  const lines: string[] = [
    `GAEB Leistungsverzeichnis (Phase X${document.phase})${meta.projectName ? ` — ${meta.projectName}` : ""}`,
    [
      meta.boqName ? `LV: ${meta.boqName}` : null,
      `Währung: ${meta.currency ?? "EUR"}`,
      meta.vatRate !== null ? `USt: ${meta.vatRate}%` : null,
      `${document.stats.itemCount} Positionen`,
    ]
      .filter(Boolean)
      .join(" | "),
  ];
  if (meta.buyer?.name) {
    lines.push(
      `Auftraggeber: ${meta.buyer.name}${meta.buyer.city ? `, ${meta.buyer.zip ?? ""} ${meta.buyer.city}`.trimEnd() : ""}`,
    );
  }
  if (meta.offerDeadline) lines.push(`Frist: ${meta.offerDeadline}`);
  lines.push("");

  if (document.preliminaryText) {
    lines.push("VORBEMERKUNGEN:");
    lines.push(document.preliminaryText.slice(0, PRELIMINARY_CAP));
    lines.push("");
  }

  lines.push("GLIEDERUNG UND POSITIONEN:");
  const itemsByCategory = new Map<string, GaebItem[]>();
  for (const item of document.items) {
    const list = itemsByCategory.get(item.categoryKey) ?? [];
    list.push(item);
    itemsByCategory.set(item.categoryKey, list);
  }
  const byKey = new Map(document.categories.map((category) => [category.key, category]));
  const emitCategory = (categoryKey: string): void => {
    const category = byKey.get(categoryKey);
    if (!category) return;
    const indent = "  ".repeat(category.depth);
    lines.push(`${indent}${category.oz} ${category.label}`.trimEnd());
    for (const item of itemsByCategory.get(categoryKey) ?? []) {
      lines.push(`${indent}  ${itemLine(item)}`);
    }
    for (const childKey of category.childKeys) emitCategory(childKey);
  };
  for (const category of document.categories) {
    if (category.parentKey === null) emitCategory(category.key);
  }
  // Items attached to a synthetic root (bodies without categories).
  for (const item of document.items) {
    if (!byKey.get(item.categoryKey)?.label && !byKey.has(item.categoryKey)) {
      lines.push(itemLine(item));
    }
  }

  return lines.join("\n");
}

function itemLine(item: GaebItem): string {
  const qty =
    item.qty !== null ? `${item.qty} ${item.qtyUnit ?? ""}`.trimEnd() : (item.qtyUnit ?? "");
  const markers = item.markers.map((marker) => MARKER_LABELS[marker]);
  if (item.notInTotal) markers.push("nicht in Summe");
  const price =
    item.existingUnitPrice !== null
      ? ` [EP ${item.existingUnitPrice.toFixed(2)}${item.existingTotal !== null ? ` / GB ${item.existingTotal.toFixed(2)}` : ""}]`
      : "";
  return `${item.oz} | ${qty} | ${item.shortText}${markers.length ? ` (${markers.join(", ")})` : ""}${price}`;
}
