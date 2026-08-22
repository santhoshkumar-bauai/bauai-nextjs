"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Download, Loader2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { DoraPanel } from "@/components/dora/dora-panel";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/onlyoffice/confirm-dialog";
import { gaebPhaseSupportsPricing, type GaebPhase } from "@/lib/gaeb/format";
import { cn } from "@/lib/utils";

import type { GaebApiFillItem, GaebApiItem } from "./api-types";
import { BoqTable } from "./boq-table";
import { FillProgress } from "./fill-progress";
import { GaebUnsupported } from "./gaeb-unsupported";
import { PositionDetail } from "./position-detail";
import { ReviewToolbar, type GaebFilterKey } from "./review-toolbar";
import { TotalsBar } from "./totals-bar";
import { useGaebDocument, type WorkingPrice } from "./use-gaeb-document";
import { useGaebFill } from "./use-gaeb-fill";

/**
 * The GAEB bill-of-quantities workspace: hierarchical position table with
 * inline pricing, Dora's batched price suggestions with a mandatory review
 * flow, live deterministic totals, and X84 export. GAEB is not an ONLYOFFICE
 * format — this surface owns the whole experience.
 */
export function GaebWorkspace({
  documentId,
  fileName,
  extension,
  aiAvailable = false,
}: {
  documentId: string;
  fileName: string;
  extension: string;
  aiAvailable?: boolean;
}) {
  const t = useTranslations("Gaeb");
  const locale = useLocale();

  const doc = useGaebDocument(documentId);
  const parsed = doc.parsed;
  const fill = useGaebFill(documentId, doc.view?.source.storageRevision ?? null);

  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [filter, setFilter] = useState<GaebFilterKey>("all");
  const [search, setSearch] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [bulkConfirmKeys, setBulkConfirmKeys] = useState<string[] | null>(null);
  const [exportConfirm, setExportConfirm] = useState(false);
  const [doraOpen, setDoraOpen] = useState(false);
  const [busyDownload, setBusyDownload] = useState(false);

  const phase = (parsed?.phase ?? null) as GaebPhase | null;
  const readOnly = phase !== null && !gaebPhaseSupportsPricing(phase);
  const canFill = Boolean(parsed && parsed.flavor === "xml" && !readOnly);
  const fillActive = fill.run?.status === "queued" || fill.run?.status === "analyzing";
  const currency = parsed?.meta.currency ?? "EUR";
  const phaseLabel = extension.toUpperCase();

  const download = async () => {
    setBusyDownload(true);
    const response = await fetch(`/api/workspace-documents/${documentId}/download`);
    const body = (await response.json()) as { downloadUrl?: string };
    if (body.downloadUrl) window.open(body.downloadUrl, "_blank", "noopener,noreferrer");
    setBusyDownload(false);
  };

  const bucketOf = (
    item: GaebApiItem,
    working: WorkingPrice | undefined,
    fillItem: GaebApiFillItem | undefined,
  ): Exclude<GaebFilterKey, "all"> => {
    if (working?.decision === "accepted") return "accepted";
    if (working?.decision === "edited" || working?.decision === "manual") return "edited";
    if (working?.decision === "rejected") return "rejected";
    if (fillItem?.status === "failed") return "failed";
    if (fillItem?.status === "priced") return "suggested";
    if (working?.unitPrice !== null && working?.unitPrice !== undefined) return "edited";
    return "unpriced";
  };

  const { visibleKeys, counts, bulkVisible, bulkConfident } = useMemo(() => {
    const visible = new Set<string>();
    const counts: Record<GaebFilterKey, number> = {
      all: 0,
      unpriced: 0,
      suggested: 0,
      accepted: 0,
      edited: 0,
      rejected: 0,
      failed: 0,
    };
    const bulkVisible: string[] = [];
    const bulkConfident: string[] = [];
    if (!parsed) return { visibleKeys: visible, counts, bulkVisible, bulkConfident };

    const query = search.trim().toLowerCase();
    counts.all = parsed.items.length;
    for (const item of parsed.items) {
      const working = doc.prices.get(item.key);
      const fillItem = fill.suggestions.get(item.key);
      const bucket = bucketOf(item, working, fillItem);
      counts[bucket] += 1;

      const matchesFilter = filter === "all" || bucket === filter;
      const matchesSearch =
        query === "" ||
        item.oz.toLowerCase().includes(query) ||
        item.shortText.toLowerCase().includes(query);
      const isVisible = matchesFilter && matchesSearch;
      if (isVisible) visible.add(item.key);

      const undecidedSuggestion =
        fillItem?.status === "priced" && fillItem.suggestion && !working?.decision;
      if (undecidedSuggestion) {
        if (isVisible) bulkVisible.push(item.key);
        if ((fillItem.suggestion?.confidence ?? 0) >= 0.8) bulkConfident.push(item.key);
      }
    }
    return { visibleKeys: visible, counts, bulkVisible, bulkConfident };
  }, [doc.prices, fill.suggestions, filter, parsed, search]);

  const acceptOne = (itemKey: string) => {
    const suggestion = fill.suggestions.get(itemKey)?.suggestion;
    if (!suggestion) return;
    doc.applyEdits([
      {
        itemKey,
        unitPrice: suggestion.unitPrice,
        decision: "accepted",
        suggestionRunId: fill.run?.id ?? null,
      },
    ]);
  };

  const rejectOne = (itemKey: string) => {
    const working = doc.prices.get(itemKey);
    if (working?.decision === "manual" || working?.decision === "edited") return;
    doc.applyEdits([
      { itemKey, unitPrice: null, decision: "rejected", suggestionRunId: fill.run?.id ?? null },
    ]);
  };

  const commitPrice = (itemKey: string, value: number | null) => {
    const suggestion = fill.suggestions.get(itemKey)?.suggestion;
    const decision =
      value === null
        ? null
        : suggestion && value === suggestion.unitPrice
          ? ("accepted" as const)
          : suggestion
            ? ("edited" as const)
            : ("manual" as const);
    doc.applyEdits([
      { itemKey, unitPrice: value, decision, suggestionRunId: fill.run?.id ?? null },
    ]);
  };

  const acceptMany = (keys: string[]) => {
    const runId = fill.run?.id ?? null;
    const edits = keys.flatMap((itemKey) => {
      const suggestion = fill.suggestions.get(itemKey)?.suggestion;
      return suggestion
        ? [
            {
              itemKey,
              unitPrice: suggestion.unitPrice,
              decision: "accepted" as const,
              suggestionRunId: runId,
            },
          ]
        : [];
    });
    doc.applyEdits(edits);
  };

  const toggleCategory = (categoryKey: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(categoryKey)) next.delete(categoryKey);
      else next.add(categoryKey);
      return next;
    });
  };

  const header = (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
      <Link
        href="/document-filler"
        aria-label={t("editor.back")}
        title={t("editor.back")}
        className={buttonVariants({ variant: "ghost", size: "icon" })}
      >
        <ArrowLeft />
      </Link>
      <Image src="/brand/logo_small.svg" width={28} height={28} alt="BAU AI" />
      <div className="min-w-0 flex-1">
        <h1 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          <span className="truncate">{fileName}</span>
          <Badge variant="neutral" className="shrink-0 px-1.5 py-0 text-[10px]">
            {phaseLabel}
          </Badge>
        </h1>
        <p className="truncate text-[11px] text-muted-foreground">
          {parsed?.meta.projectName ?? t("editor.subtitle", { phase: phaseLabel })}
          {doc.saving ? " · …" : ""}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        title={t("editor.download")}
        aria-label={t("editor.download")}
        disabled={busyDownload}
        onClick={() => void download()}
      >
        {busyDownload ? <Loader2 className="animate-spin" /> : <Download />}
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setDoraOpen(!doraOpen)}
        className={cn(
          "hidden md:flex",
          doraOpen && "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10 hover:text-primary",
        )}
        title={t("editor.dora")}
      >
        <Sparkles />
        {t("editor.dora")}
      </Button>
    </header>
  );

  let body: React.ReactNode;
  if (doc.loadState === "loading") {
    body = (
      <div className="flex flex-1 items-center justify-center">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          {t("editor.loading")}
        </p>
      </div>
    );
  } else if (doc.loadState === "error" || !doc.view) {
    body = (
      <div className="flex flex-1 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{t("editor.loadFailed")}</p>
        <Button variant="outline" onClick={() => void doc.reload()}>
          {t("editor.retry")}
        </Button>
      </div>
    );
  } else if (doc.view.gaeb.parseError || !parsed) {
    const error = doc.view.gaeb.parseError;
    body = (
      <GaebUnsupported
        variant={error?.code === "unsupported_flavor" ? "legacy" : "parse_error"}
        code={error?.code}
        extension={doc.view.source.extension}
        onDownload={() => void download()}
      />
    );
  } else {
    body = (
      <>
        {!readOnly && (
          <FillProgress
            run={fill.run}
            canFill={canFill}
            aiAvailable={aiAvailable}
            busy={fill.busy}
            actionError={fill.actionError}
            onStart={() => void fill.start()}
            onRetryFailed={() => void fill.retryFailed()}
            onCancel={() => void fill.cancel()}
          />
        )}
        {readOnly && (
          <div className="border-b border-border bg-muted/50 px-4 py-2 text-[12px] text-muted-foreground">
            {t("unsupported.phaseBody", { phase: parsed.phase })}
          </div>
        )}
        {doc.sourceConflict && (
          <div className="flex flex-wrap items-center gap-3 border-b border-border bg-amber-50/80 px-4 py-2 text-[12px] text-amber-800">
            <span className="min-w-0 flex-1">{t("banner.stale")}</span>
            <Button variant="outline" size="sm" onClick={() => void doc.resetForCurrentVersion()}>
              {t("banner.reset")}
            </Button>
          </div>
        )}
        <ReviewToolbar
          filter={filter}
          counts={counts}
          search={search}
          bulkVisibleCount={bulkVisible.length}
          bulkConfidentCount={bulkConfident.length}
          onFilterChange={setFilter}
          onSearchChange={setSearch}
          onExpandAll={() => setCollapsed(new Set())}
          onCollapseAll={() => setCollapsed(new Set(parsed.categories.map((c) => c.key)))}
          onBulkAcceptVisible={() => setBulkConfirmKeys(bulkVisible)}
          onBulkAcceptConfident={() => setBulkConfirmKeys(bulkConfident)}
        />
        <div className="min-h-0 flex-1 overflow-auto">
          <BoqTable
            parsed={parsed}
            visibleKeys={visibleKeys}
            collapsed={collapsed}
            onToggleCategory={toggleCategory}
            prices={doc.prices}
            totals={doc.totals}
            suggestions={fill.suggestions}
            fillActive={Boolean(fillActive)}
            locale={locale}
            currency={currency}
            readOnly={readOnly}
            selectedKey={selectedKey}
            onCommitPrice={commitPrice}
            onAccept={acceptOne}
            onReject={rejectOne}
            onSelect={setSelectedKey}
          />
        </div>
        <TotalsBar
          totals={doc.totals}
          vatRate={parsed.meta.vatRate}
          locale={locale}
          currency={currency}
          readOnly={readOnly}
          exportBusy={fill.busy === "generate" || fill.run?.status === "generating"}
          onExport={() => setExportConfirm(true)}
        />
      </>
    );
  }

  return (
    <main className="flex h-svh min-h-0 flex-col bg-white">
      {header}
      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</section>
        {doraOpen && (
          <aside className="hidden w-[400px] shrink-0 border-l border-border md:block">
            <DoraPanel
              documentId={documentId}
              aiAvailable={aiAvailable}
              onClose={() => setDoraOpen(false)}
            />
          </aside>
        )}
      </div>

      {selectedKey && (
        <PositionDetail
          key={selectedKey}
          documentId={documentId}
          itemKey={selectedKey}
          fillItem={fill.suggestions.get(selectedKey)}
          working={doc.prices.get(selectedKey)}
          locale={locale}
          currency={currency}
          readOnly={readOnly}
          onAccept={acceptOne}
          onReject={rejectOne}
          onClose={() => setSelectedKey(null)}
        />
      )}

      <ConfirmDialog
        open={bulkConfirmKeys !== null}
        onOpenChange={(open) => !open && setBulkConfirmKeys(null)}
        title={t("bulk.confirmTitle")}
        description={t("bulk.confirmBody", { count: bulkConfirmKeys?.length ?? 0 })}
        confirmLabel={t("bulk.confirm")}
        cancelLabel={t("bulk.cancel")}
        onConfirm={() => {
          if (bulkConfirmKeys) acceptMany(bulkConfirmKeys);
          setBulkConfirmKeys(null);
        }}
      />
      <ConfirmDialog
        open={exportConfirm}
        onOpenChange={setExportConfirm}
        title={t("totals.confirmTitle")}
        description={t("totals.confirmBody")}
        confirmLabel={t("totals.confirm")}
        cancelLabel={t("totals.cancel")}
        onConfirm={() => {
          setExportConfirm(false);
          void fill.generate();
        }}
      />
    </main>
  );
}
