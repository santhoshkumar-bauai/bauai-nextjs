"use client";

import {
  ArrowUpRight,
  Check,
  ExternalLink,
  FileText,
  MapPin,
  Scale,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BlockPayload, TenderCard } from "@/lib/ai/iris/blocks";
import { cn } from "@/lib/utils";

import { useIrisActions } from "../iris-context";
import { BlockShell } from "../block-shell";
import {
  BlockEmpty,
  DeadlinePill,
  Field,
  ScoreBar,
  ScoreRing,
  TONE_BADGE,
} from "../primitives";

/**
 * The tender family: the grid, the spotlight and the comparison.
 *
 * These three are the reason the POC exists. "Which tenders should we bid on"
 * is the product's central question and prose is the worst possible answer to
 * it — the reader needs to scan eight opportunities by deadline pressure and
 * match strength at once, then open one, then put two side by side. Each of
 * those is a different LAYOUT, and the agent picking between them is what
 * generative UI buys.
 */

// ---------------------------------------------------------------------------
// Shared card
// ---------------------------------------------------------------------------

function money(
  value: TenderCard["estimatedValue"],
  format: ReturnType<typeof useFormatter>,
): string | null {
  if (!value?.amount) return null;
  const numeric = Number(value.amount);
  if (!Number.isFinite(numeric)) return value.amount;
  return `${format.number(numeric, { maximumFractionDigits: 0 })}${
    value.currency ? ` ${value.currency}` : ""
  }`;
}

export function TenderMiniCard({
  tender,
  selected,
  onToggleSelect,
}: {
  tender: TenderCard;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const t = useTranslations("GenUi.blocks");
  const format = useFormatter();
  const value = money(tender.estimatedValue, format);

  return (
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border bg-card transition-all",
        selected
          ? "border-primary ring-2 ring-primary/15"
          : "border-border hover:border-primary/40 hover:shadow-[0_2px_10px_rgba(80,0,168,0.06)]",
      )}
    >
      {onToggleSelect ? (
        <button
          type="button"
          onClick={onToggleSelect}
          aria-pressed={selected}
          aria-label={t("select")}
          className={cn(
            "absolute top-2.5 right-2.5 z-10 grid size-5 place-items-center rounded-md border transition-colors",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background text-transparent hover:border-primary/50 hover:text-primary/40",
          )}
        >
          <Check className="size-3" />
        </button>
      ) : null}

      <Link
        href={`/tenders/${tender.tenderId}`}
        className="flex flex-1 items-start gap-3 p-3"
      >
        {tender.matchScore != null ? (
          <ScoreRing value={tender.matchScore} label={t("match")} />
        ) : null}

        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 pr-6 text-sm font-medium text-foreground group-hover:text-primary">
            {tender.title ?? t("untitled")}
          </p>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">
            {[tender.buyer, tender.city].filter(Boolean).join(" · ") || t("unknownBuyer")}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-1">
            <DeadlinePill daysLeft={tender.daysLeft} />
            {tender.workspaceStatus ? (
              <Badge variant="primary">
                {t.has(`board.${tender.workspaceStatus}`)
                  ? t(`board.${tender.workspaceStatus}` as "board.interested")
                  : tender.workspaceStatus}
              </Badge>
            ) : null}
            {tender.decision ? (
              <Badge
                variant={
                  tender.decision === "bid"
                    ? "success"
                    : tender.decision === "no_bid"
                      ? "danger"
                      : "warning"
                }
              >
                {t(`decision.${tender.decision}` as "decision.bid")}
              </Badge>
            ) : null}
            {value ? (
              <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                {value}
              </span>
            ) : null}
          </div>
        </div>
      </Link>

      {/* The score breakdown is the honest part of a match number: it says the
          ranking is CPV plus geography plus timing, not an oracle. */}
      {tender.scoreBreakdown ? (
        <div className="grid grid-cols-3 gap-1.5 border-t border-border/70 px-3 py-2">
          {(
            [
              ["cpv", tender.scoreBreakdown.cpv],
              ["location", tender.scoreBreakdown.location],
              ["timing", tender.scoreBreakdown.timing],
            ] as const
          ).map(([key, score]) => (
            <div key={key} className="min-w-0">
              <p className="mb-1 truncate text-[9px] tracking-wide text-muted-foreground uppercase">
                {t(`signal.${key}` as "signal.cpv")}
              </p>
              <ScoreBar value={score} tone="primary" className="h-1" />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

/**
 * A ranked list of opportunities — and, because the cards carry selection, the
 * launcher for the comparison view. That round trip (render → user picks →
 * agent renders a different block) is the pattern the whole POC is arguing
 * for: the UI is not the end of the turn, it is the input to the next one.
 */
export function TenderGridBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"tender-grid">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const { sendPrompt, isStreaming } = useIrisActions();
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (tenderId: string) =>
    setSelected((current) =>
      current.includes(tenderId)
        ? current.filter((id) => id !== tenderId)
        : current.length >= 5
          ? current
          : [...current, tenderId],
    );

  return (
    <BlockShell
      kind="tender-grid"
      blockId={blockId}
      title={block.title}
      caption={
        block.total != null
          ? t("showingOf", { shown: block.items.length, total: block.total })
          : block.caption
      }
      bare
    >
      {block.items.length === 0 ? (
        <div className="p-4">
          <BlockEmpty message={block.emptyHint ?? t("noResults")} />
        </div>
      ) : (
        <>
          <div className="grid gap-2 p-3 sm:grid-cols-2">
            {block.items.map((tender) => (
              <TenderMiniCard
                key={tender.tenderId}
                tender={tender}
                selected={selected.includes(tender.tenderId)}
                onToggleSelect={() => toggle(tender.tenderId)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-border/70 bg-muted/30 px-3 py-2">
            <p className="mr-auto text-[11px] text-muted-foreground">
              {selected.length === 0 ? t("selectHint") : t("selectedCount", { count: selected.length })}
            </p>
            <Button
              size="xs"
              variant="outline"
              disabled={selected.length < 2 || isStreaming}
              onClick={() => sendPrompt(t("comparePrompt", { ids: selected.join(", ") }))}
            >
              <Scale />
              {t("compareSelected")}
            </Button>
            <Button
              size="xs"
              disabled={selected.length !== 1 || isStreaming}
              onClick={() => sendPrompt(t("verdictPrompt", { id: selected[0] ?? "" }))}
            >
              <Sparkles />
              {t("shouldWeBid")}
            </Button>
          </div>
        </>
      )}
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Spotlight
// ---------------------------------------------------------------------------

export function TenderSpotlightBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"tender-spotlight">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");
  const format = useFormatter();
  const { sendPrompt, isStreaming } = useIrisActions();
  const { tender, coverage } = block;
  const value = money(tender.estimatedValue, format);

  return (
    <BlockShell
      kind="tender-spotlight"
      blockId={blockId}
      title={tender.title ?? t("untitled")}
      caption={tender.buyer}
      actions={
        <Link
          href={`/tenders/${tender.tenderId}`}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:text-primary"
        >
          {t("open")}
          <ArrowUpRight className="size-3" />
        </Link>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <DeadlinePill daysLeft={tender.daysLeft} />
          {tender.status ? <Badge variant="neutral">{tender.status}</Badge> : null}
          {tender.workspaceStatus ? (
            <Badge variant="primary">
              {t.has(`board.${tender.workspaceStatus}`)
                ? t(`board.${tender.workspaceStatus}` as "board.interested")
                : tender.workspaceStatus}
            </Badge>
          ) : null}
          {tender.decision ? (
            <Badge
              variant={
                tender.decision === "bid"
                  ? "success"
                  : tender.decision === "no_bid"
                    ? "danger"
                    : "warning"
              }
            >
              {t(`decision.${tender.decision}` as "decision.bid")}
            </Badge>
          ) : null}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <Field label={t("deadline")}>
            {tender.submissionDeadline
              ? format.dateTime(new Date(tender.submissionDeadline), { dateStyle: "medium" })
              : t("noDeadline")}
          </Field>
          <Field label={t("value")}>{value ?? "—"}</Field>
          <Field label={t("procedure")}>{block.procedureType ?? "—"}</Field>
          <Field label={t("contractType")}>{block.contractNature ?? "—"}</Field>
        </dl>

        {block.categories && block.categories.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {block.categories.slice(0, 6).map((category) => (
              <Badge key={category} variant="neutral">
                <MapPin />
                {category}
              </Badge>
            ))}
          </div>
        ) : null}

        {block.description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{block.description}</p>
        ) : null}

        {block.highlights && block.highlights.length > 0 ? (
          <ul className="space-y-1.5">
            {block.highlights.map((highlight) => (
              <li key={highlight} className="flex gap-2 text-xs text-foreground">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-primary" />
                <span>{highlight}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {/*
          The coverage strip is the block that stops the conversation lying.
          Without it the reader cannot tell "we analysed this and found no
          risks" from "nothing has been analysed", and both render as silence.
        */}
        {coverage ? (
          <div className="rounded-xl border border-border bg-muted/30 p-3">
            <p className="mb-2 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {t("whatWeKnow")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant={coverage.fetchedFiles > 0 ? "info" : "neutral"}>
                <FileText />
                {t("filesCount", { count: coverage.fetchedFiles })}
              </Badge>
              <Badge variant={coverage.indexedChunks > 0 ? "info" : "neutral"}>
                {t("indexedChunks", { count: coverage.indexedChunks })}
              </Badge>
              <Badge variant={coverage.extractionCount > 0 ? "success" : "neutral"}>
                {t("extractionsCount", { count: coverage.extractionCount })}
              </Badge>
              <Badge variant={coverage.hasVerdict ? "success" : "neutral"}>
                {t(coverage.hasVerdict ? "verdictReady" : "verdictMissing")}
              </Badge>
              <Badge variant={coverage.hasReport ? "success" : "neutral"}>
                {t(coverage.hasReport ? "reportReady" : "reportMissing")}
              </Badge>
            </div>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={isStreaming}
            onClick={() => sendPrompt(t("requirementsPrompt", { id: tender.tenderId }))}
          >
            {t("askRequirements")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={isStreaming}
            onClick={() => sendPrompt(t("timelinePrompt", { id: tender.tenderId }))}
          >
            {t("askTimeline")}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={isStreaming}
            onClick={() => sendPrompt(t("verdictPrompt", { id: tender.tenderId }))}
          >
            {t("shouldWeBid")}
          </Button>
          {block.sourceUrl ? (
            <a
              href={block.sourceUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
            >
              <ExternalLink className="size-3" />
              {t("source")}
            </a>
          ) : null}
        </div>
      </div>
    </BlockShell>
  );
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export function TenderCompareBlock({
  block,
  blockId,
}: {
  block: BlockPayload<"tender-compare">;
  blockId: string;
}) {
  const t = useTranslations("GenUi.blocks");

  return (
    <BlockShell
      kind="tender-compare"
      blockId={blockId}
      title={block.title}
      caption={block.caption}
      bare
    >
      {/* Wide content scrolls inside the card. A comparison of five tenders is
          intrinsically wider than a chat column and squeezing it into one
          would defeat the point of choosing a table. */}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 z-10 w-32 bg-card px-3 py-2.5 align-bottom text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                {t("criterion")}
              </th>
              {block.columns.map((column) => (
                <th
                  key={column.tenderId}
                  className="min-w-[10rem] border-l border-border/70 px-3 py-2.5 align-bottom"
                >
                  <Link
                    href={`/tenders/${column.tenderId}`}
                    className="line-clamp-2 text-xs font-semibold text-foreground hover:text-primary"
                  >
                    {column.title ?? t("untitled")}
                  </Link>
                  <p className="mt-0.5 line-clamp-1 text-[10px] font-normal text-muted-foreground">
                    {column.buyer ?? t("unknownBuyer")}
                  </p>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row) => (
              <tr key={row.label} className="border-t border-border/70">
                <th className="sticky left-0 z-10 bg-card px-3 py-2 text-[11px] font-medium text-muted-foreground">
                  {row.label}
                </th>
                {row.cells.map((cell, index) => (
                  <td
                    key={`${row.label}-${block.columns[index]?.tenderId ?? index}`}
                    className="border-l border-border/70 px-3 py-2 align-top"
                  >
                    {cell.tone && cell.tone !== "neutral" ? (
                      <Badge variant={TONE_BADGE[cell.tone]}>{cell.text}</Badge>
                    ) : (
                      <span className="text-foreground">{cell.text}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </BlockShell>
  );
}
