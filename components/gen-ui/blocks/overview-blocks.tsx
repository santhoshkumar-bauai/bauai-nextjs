"use client";

import { Building2, Check, MapPin, Users } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { BlockPayload } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

import { BlockShell } from "../block-shell";
import { BlockEmpty, DeadlinePill, Field, ScoreBar, TONE_TEXT } from "../primitives";
import { useIrisActions } from "../iris-context";

/**
 * The overview family: numbers, the board, the CPV catalogue and the company
 * itself. These are the "where am I" blocks — the ones a session opens with
 * and returns to between drill-ins.
 */

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export function MetricSummaryBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"metric-summary">;
  blockId: string;
}) {
  return (
    <BlockShell
      kind="metric-summary"
      blockId={blockId}
      title={block.title}
      caption={block.caption}
      bare
    >
      {/* auto-fit rather than a fixed column count: the tool emits between two
          and six tiles and a five-tile row must not leave a hole. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(7.5rem,1fr))] divide-x divide-y divide-border/70">
        {block.metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 px-4 py-3">
            <p className="truncate text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              {metric.label}
            </p>
            <p
              className={cn(
                "mt-1 text-2xl leading-none font-semibold tabular-nums tracking-tight",
                metric.tone ? TONE_TEXT[metric.tone] : "text-foreground",
              )}
            >
              {metric.value}
              {metric.unit ? (
                <span className="ml-0.5 text-sm font-normal text-muted-foreground">
                  {metric.unit}
                </span>
              ) : null}
            </p>
            {metric.progress != null ? (
              <ScoreBar
                value={metric.progress}
                tone={metric.tone ?? "primary"}
                className="mt-2 h-1"
              />
            ) : null}
            {metric.hint ? (
              <p className="mt-1 truncate text-[10px] text-muted-foreground">{metric.hint}</p>
            ) : null}
          </div>
        ))}
      </div>
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

const COLUMN_ACCENT: Record<string, string> = {
  interested: "bg-sky-400",
  preparing: "bg-primary",
  submitted: "bg-amber-400",
  won: "bg-emerald-500",
  lost: "bg-rose-400",
};

export function PipelineBoardBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"pipeline-board">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");

  const total = block.columns.reduce((sum, column) => sum + column.count, 0);

  return (
    <BlockShell
      kind="pipeline-board"
      blockId={blockId}
      title={block.title}
      caption={block.caption}
      bare
    >
      {total === 0 ? (
        <div className="p-4">
          <BlockEmpty message={t("emptyBoard")} />
        </div>
      ) : (
        // The board is horizontally scrollable inside the card: five columns
        // will never fit a chat column, and stacking them vertically destroys
        // the one thing a board is for.
        <div className="overflow-x-auto p-3">
          <div className="flex min-w-max gap-2.5">
            {block.columns.map((column) => (
              <section key={column.status} className="w-48 shrink-0">
                <header className="mb-1.5 flex items-center gap-1.5">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      COLUMN_ACCENT[column.status] ?? "bg-muted-foreground",
                    )}
                  />
                  <h4 className="truncate text-[11px] font-semibold text-foreground">
                    {t.has(`board.${column.status}`)
                      ? t(`board.${column.status}` as "board.interested")
                      : column.status}
                  </h4>
                  <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                    {column.count}
                  </span>
                </header>
                <div className="space-y-1.5">
                  {column.items.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border py-4" />
                  ) : (
                    column.items.map((item) => (
                      <Link
                        key={item.tenderId}
                        href={`/tenders/${item.tenderId}`}
                        className="block rounded-lg border border-border bg-card p-2 transition-colors hover:border-primary/40"
                      >
                        <p className="line-clamp-2 text-[11px] font-medium text-foreground">
                          {item.title ?? t("untitled")}
                        </p>
                        <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">
                          {item.buyer ?? t("unknownBuyer")}
                        </p>
                        <div className="mt-1.5">
                          <DeadlinePill daysLeft={item.daysLeft} />
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// CPV
// ---------------------------------------------------------------------------

export function CpvExplorerBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"cpv-explorer">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const { sendPrompt, isStreaming } = useIrisActions();

  return (
    <BlockShell
      kind="cpv-explorer"
      blockId={blockId}
      title={block.title}
      caption={block.caption}
    >
      {block.items.length === 0 ? (
        <BlockEmpty message={t("noCpv")} />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {block.items.map((item) => (
            <button
              key={item.code}
              type="button"
              disabled={isStreaming}
              onClick={() => sendPrompt(t("cpvPrompt", { code: item.code, name: item.name }))}
              className={cn(
                "group flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-left transition-colors disabled:opacity-60",
                item.onProfile
                  ? "border-primary/30 bg-primary/8 hover:bg-primary/12"
                  : "border-border bg-card hover:border-primary/30",
              )}
            >
              {item.onProfile ? <Check className="size-3 shrink-0 text-primary" /> : null}
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {item.code}
              </span>
              <span className="truncate text-[11px] text-foreground">{item.name}</span>
            </button>
          ))}
        </div>
      )}
      <p className="mt-3 text-[10px] text-muted-foreground">{t("cpvProfileHint")}</p>
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

export function CompanySnapshotBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"company-snapshot">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");

  return (
    <BlockShell
      kind="company-snapshot"
      blockId={blockId}
      title={block.name}
      caption={[block.city, block.country].filter(Boolean).join(", ") || null}
    >
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label={t("employees")}>
            <span className="inline-flex items-center gap-1">
              <Users className="size-3 text-muted-foreground" />
              {block.employees ?? "—"}
            </span>
          </Field>
          <Field label={t("founded")}>{block.foundedYear ?? "—"}</Field>
          <Field label={t("region")}>
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3 text-muted-foreground" />
              {block.regions[0] ?? "—"}
            </span>
          </Field>
          <Field label={t("documents")}>
            {block.indexedDocumentCount != null && block.documentCount != null
              ? `${block.indexedDocumentCount}/${block.documentCount}`
              : (block.documentCount ?? "—")}
          </Field>
        </dl>

        {block.capabilities.length > 0 ? (
          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("capabilities")}
            </h4>
            <div className="flex flex-wrap gap-1">
              {block.capabilities.map((capability) => (
                <Badge key={capability} variant="neutral">
                  {capability}
                </Badge>
              ))}
            </div>
          </section>
        ) : null}

        {block.cpvCodes.length > 0 ? (
          <section>
            <h4 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("cpvOnProfile")}
            </h4>
            <div className="flex flex-wrap gap-1">
              {block.cpvCodes.map((entry) => (
                <Badge key={entry.code} variant="primary">
                  <Building2 />
                  <span className="font-mono tabular-nums">{entry.code}</span>
                  <span className="max-w-40 truncate">{entry.name}</span>
                </Badge>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </BlockShell>
  );
}
