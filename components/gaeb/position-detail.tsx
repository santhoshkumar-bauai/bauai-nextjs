"use client";

import { Check, Loader2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import type { GaebApiFillItem, GaebItemDetailResponse } from "./api-types";
import { formatMoney, formatQty } from "./price-format";
import type { WorkingPrice } from "./use-gaeb-document";

/**
 * Right-hand detail sheet for the selected position: full Langtext (lazy),
 * Dora's classification and priced suggestion with assumptions, risks, and
 * sources — the audit trail behind every number.
 */
export function PositionDetail({
  documentId,
  itemKey,
  fillItem,
  working,
  locale,
  currency,
  readOnly,
  onAccept,
  onReject,
  onClose,
}: {
  documentId: string;
  itemKey: string;
  fillItem: GaebApiFillItem | undefined;
  working: WorkingPrice | undefined;
  locale: string;
  currency: string;
  readOnly: boolean;
  onAccept: (itemKey: string) => void;
  onReject: (itemKey: string) => void;
  onClose: () => void;
}) {
  const t = useTranslations("Gaeb.detail");
  const tMarkers = useTranslations("Gaeb.markers");
  const [detail, setDetail] = useState<GaebItemDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);

  // The workspace keys this component by itemKey, so a selection change
  // remounts it — initial state covers the reset, the effect only fetches.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/workspace-documents/${documentId}/gaeb/items/${itemKey}`,
          { cache: "no-store" },
        );
        if (!response.ok || cancelled) return;
        const body = (await response.json()) as GaebItemDetailResponse;
        if (!cancelled) setDetail(body);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [documentId, itemKey]);

  const suggestion =
    fillItem?.suggestion ?? (detail?.fillItem?.status === "priced" ? detail.fillItem.suggestion : null);
  const classification = fillItem?.classification ?? detail?.fillItem?.classification ?? null;
  const item = detail?.item;
  const decisionOpen = suggestion && (working?.decision ?? null) === null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[1px]"
      onClick={onClose}
    >
      <aside
        className="flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-card px-5 py-4">
          <div className="min-w-0">
            <p className="text-[11px] tabular-nums text-muted-foreground">
              {item?.categoryPath.map((entry) => entry.label).join(" › ")}
            </p>
            <h2 className="mt-0.5 text-sm font-semibold text-foreground">
              <span className="mr-2 tabular-nums text-muted-foreground">{item?.oz}</span>
              {item?.shortText}
            </h2>
          </div>
          <Button variant="ghost" size="icon" aria-label={t("close")} title={t("close")} onClick={onClose}>
            <X />
          </Button>
        </header>

        <div className="flex-1 space-y-5 px-5 py-4">
          {loading && !item ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> …
            </p>
          ) : null}

          {item && (
            <section className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span>
                {t("quantity")}:{" "}
                <strong className="tabular-nums text-foreground">
                  {formatQty(item.qty, locale)} {item.qtyUnit ?? ""}
                </strong>
              </span>
              {item.markers.map((marker) => (
                <Badge key={marker} variant="neutral" className="px-1.5 py-0 text-[10px]">
                  {tMarkers(marker)}
                </Badge>
              ))}
              {item.notInTotal && (
                <Badge variant="warning" className="px-1.5 py-0 text-[10px]">
                  {tMarkers("notInTotal")}
                </Badge>
              )}
            </section>
          )}

          {suggestion ? (
            <section className="rounded-xl border border-primary/25 bg-primary/[0.04] p-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[12px] font-semibold uppercase tracking-wide text-primary">
                  {t("suggestion")}
                </h3>
                <Badge variant="neutral" className="px-1.5 py-0 text-[10px]">
                  {t("confidence", { percent: Math.round(suggestion.confidence * 100) })}
                </Badge>
              </div>
              <p className="mt-2 text-xl font-semibold tabular-nums text-foreground">
                {formatMoney(suggestion.unitPrice, locale, currency)}
              </p>
              <p className="text-[12px] tabular-nums text-muted-foreground">
                {t("range")}: {formatMoney(suggestion.rangeLow, locale, currency)} –{" "}
                {formatMoney(suggestion.rangeHigh, locale, currency)}
              </p>
              {suggestion.reason && (
                <p className="mt-2 text-[12px] text-foreground">{suggestion.reason}</p>
              )}
              <p className="mt-2 text-[11px] text-muted-foreground">{t("estimateNote")}</p>
              {decisionOpen && !readOnly && (
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => onAccept(itemKey)}>
                    <Check /> {t("accept")}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onReject(itemKey)}>
                    <X /> {t("reject")}
                  </Button>
                </div>
              )}
            </section>
          ) : fillItem?.status === "failed" ? (
            <p className="rounded-xl border border-red-200 bg-red-50/60 p-3 text-[12px] text-red-700">
              {t("failed")}
            </p>
          ) : (
            <p className="text-[12px] text-muted-foreground">{t("noSuggestion")}</p>
          )}

          {classification && (
            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("classification")}
              </h3>
              <p className="mt-1.5 flex flex-wrap gap-1">
                <Badge variant="neutral">{classification.trade}</Badge>
                {classification.workCategory && (
                  <Badge variant="neutral">{classification.workCategory}</Badge>
                )}
                {classification.attributes.map((attribute) => (
                  <Badge key={attribute} variant="neutral" className="text-[10px]">
                    {attribute}
                  </Badge>
                ))}
              </p>
            </section>
          )}

          {suggestion && suggestion.assumptions.length > 0 && (
            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("assumptions")}
              </h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12px] text-foreground">
                {suggestion.assumptions.map((assumption) => (
                  <li key={assumption}>{assumption}</li>
                ))}
              </ul>
            </section>
          )}

          {suggestion && suggestion.risks.length > 0 && (
            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("risks")}
              </h3>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[12px] text-amber-800">
                {suggestion.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </section>
          )}

          {suggestion && suggestion.evidence.length > 0 && (
            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("evidence")}
              </h3>
              <ul className="mt-1.5 space-y-2">
                {suggestion.evidence.map((evidence, index) => (
                  <li key={index} className="rounded-lg border border-border p-2 text-[11px]">
                    <p className="font-medium text-foreground">
                      {evidence.source === "web" && evidence.reference.startsWith("http") ? (
                        <a
                          href={evidence.reference}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary underline-offset-2 hover:underline"
                        >
                          {evidence.reference}
                        </a>
                      ) : (
                        evidence.reference
                      )}
                    </p>
                    {evidence.excerpt && (
                      <p className="mt-0.5 text-muted-foreground">{evidence.excerpt}</p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {item?.longText && (
            <section>
              <h3 className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("longText")}
              </h3>
              <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground">
                {item.longText}
              </p>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
}
