"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";

import type { GaebCategory } from "@/lib/gaeb/types";
import type { GaebTotals } from "@/lib/gaeb/totals";

import type { GaebApiFillItem, GaebApiItem, GaebApiParsed } from "./api-types";
import { BOQ_GRID, BoqRow } from "./boq-row";
import { CategoryRow } from "./category-row";
import type { WorkingPrice } from "./use-gaeb-document";

/**
 * The hierarchical BOQ table. Plain DOM — 500+ rows stay smooth through
 * `content-visibility: auto` on rows, no table/virtualization dependency.
 */

type Row =
  | { kind: "category"; category: GaebCategory; visibleItems: number }
  | { kind: "item"; item: GaebApiItem; depth: number };

export function BoqTable({
  parsed,
  visibleKeys,
  collapsed,
  onToggleCategory,
  prices,
  totals,
  suggestions,
  fillActive,
  locale,
  currency,
  readOnly,
  selectedKey,
  onCommitPrice,
  onAccept,
  onReject,
  onSelect,
}: {
  parsed: GaebApiParsed;
  /** Item keys passing the active filter; categories follow from them. */
  visibleKeys: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggleCategory: (categoryKey: string) => void;
  prices: ReadonlyMap<string, WorkingPrice>;
  totals: GaebTotals | null;
  suggestions: ReadonlyMap<string, GaebApiFillItem>;
  fillActive: boolean;
  locale: string;
  currency: string;
  readOnly: boolean;
  selectedKey: string | null;
  onCommitPrice: (itemKey: string, value: number | null) => void;
  onAccept: (itemKey: string) => void;
  onReject: (itemKey: string) => void;
  onSelect: (itemKey: string) => void;
}) {
  const t = useTranslations("Gaeb.table");

  const rows = useMemo<Row[]>(() => {
    const byKey = new Map(parsed.categories.map((category) => [category.key, category]));
    const itemsByKey = new Map(parsed.items.map((item) => [item.key, item]));

    // Categories with at least one visible item beneath them stay visible.
    const visibleItemCount = new Map<string, number>();
    for (const item of parsed.items) {
      if (!visibleKeys.has(item.key)) continue;
      let key: string | null = item.categoryKey;
      const seen = new Set<string>();
      while (key && !seen.has(key)) {
        seen.add(key);
        visibleItemCount.set(key, (visibleItemCount.get(key) ?? 0) + 1);
        key = byKey.get(key)?.parentKey ?? null;
      }
    }

    const out: Row[] = [];
    const walk = (category: GaebCategory) => {
      const visible = visibleItemCount.get(category.key) ?? 0;
      if (visible === 0) return;
      out.push({ kind: "category", category, visibleItems: visible });
      if (collapsed.has(category.key)) return;
      for (const itemKey of category.itemKeys) {
        if (!visibleKeys.has(itemKey)) continue;
        const item = itemsByKey.get(itemKey);
        if (item) out.push({ kind: "item", item, depth: category.depth + 1 });
      }
      for (const childKey of category.childKeys) {
        const child = byKey.get(childKey);
        if (child) walk(child);
      }
    };
    for (const category of parsed.categories) {
      if (category.parentKey === null) walk(category);
    }
    return out;
  }, [collapsed, parsed, visibleKeys]);

  return (
    <div role="table" aria-rowcount={rows.length} className="min-w-[560px] md:min-w-[900px]">
      <div
        className={`${BOQ_GRID} sticky top-0 z-10 border-b border-border bg-white text-[11px] font-medium uppercase tracking-wide text-muted-foreground`}
        role="row"
      >
        <div className="px-3 py-2">{t("oz")}</div>
        <div className="py-2 pr-2">{t("shortText")}</div>
        <div className="hidden py-2 pr-2 text-right md:block">{t("qty")}</div>
        <div className="hidden py-2 pr-2 md:block">{t("unit")}</div>
        <div className="py-2 pr-2">{t("suggestion")}</div>
        <div className="py-2 pr-2 text-right">{t("unitPrice")}</div>
        <div className="hidden py-2 pr-3 text-right md:block">{t("total")}</div>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t("emptyFilter")}</p>
      ) : (
        rows.map((row) =>
          row.kind === "category" ? (
            <CategoryRow
              key={row.category.key}
              category={row.category}
              collapsed={collapsed.has(row.category.key)}
              subtotal={totals?.byCategory.get(row.category.key)?.net ?? null}
              itemCount={row.visibleItems}
              locale={locale}
              currency={currency}
              onToggle={() => onToggleCategory(row.category.key)}
            />
          ) : (
            <BoqRow
              key={row.item.key}
              item={row.item}
              depth={row.depth}
              working={prices.get(row.item.key)}
              lineTotal={totals?.byItem.get(row.item.key)?.total ?? null}
              fillItem={suggestions.get(row.item.key)}
              fillActive={fillActive}
              locale={locale}
              currency={currency}
              readOnly={readOnly}
              selected={selectedKey === row.item.key}
              onCommitPrice={onCommitPrice}
              onAccept={onAccept}
              onReject={onReject}
              onSelect={onSelect}
            />
          ),
        )
      )}
    </div>
  );
}
