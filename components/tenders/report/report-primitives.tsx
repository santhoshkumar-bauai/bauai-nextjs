"use client";

import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import type { ChatCitation } from "@/lib/ai/agent/citations";
import { cn } from "@/lib/utils";

/**
 * Shared building blocks for the on-screen report. The exports render their
 * own markup (paginated HTML / Word), so these stay purely presentational and
 * screen-oriented — the shared contract between the three renderers is the
 * report data and the labels, never the layout.
 */

/** Model prose uses \n\n for paragraph breaks; nothing else is markup. */
export function Prose({ text }: { text: string | null | undefined }) {
  if (!text?.trim()) return null;
  return (
    <div className="flex flex-col gap-3">
      {text.split(/\n{2,}/).map((block, index) => (
        <p key={index} className="text-sm leading-relaxed whitespace-pre-line text-foreground/90">
          {block.trim()}
        </p>
      ))}
    </div>
  );
}

export function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-border pt-6">
      <h2 className="mb-3 text-sm font-semibold tracking-wide text-primary uppercase">
        {title}
      </h2>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

export function Bullets({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-foreground/90">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

/**
 * Evidence chips. IDs the model cited but the server could not resolve are
 * dropped — an unresolvable citation is worse than none.
 */
export function Cites({
  ids,
  citations,
}: {
  ids: string[];
  citations: Record<string, ChatCitation>;
}) {
  const known = ids.filter((id) => citations[id]);
  if (known.length === 0) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {known.map((id) => (
        <span
          key={id}
          title={`${citations[id].fileName} — ${citations[id].quote}`}
          className="cursor-help rounded bg-primary/10 px-1 py-px font-mono text-[9px] font-semibold text-primary"
        >
          {id}
        </span>
      ))}
    </span>
  );
}

export function CitedBullets({
  items,
  citations,
}: {
  items: Array<{ text: string; evidenceIds: string[] }>;
  citations: Record<string, ChatCitation>;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-foreground/90">
      {items.map((item, index) => (
        <li key={index}>
          {item.text}
          <Cites ids={item.evidenceIds} citations={citations} />
        </li>
      ))}
    </ul>
  );
}

/** Horizontally scrollable so a wide table never breaks the page layout. */
export function DataTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: ReactNode[][];
}) {
  if (rows.length === 0) return null;
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                className="border-b border-border bg-muted/50 px-2.5 py-2 font-semibold text-muted-foreground"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="align-top">
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  className="border-b border-border/60 px-2.5 py-2 text-foreground/90"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_VARIANT = {
  met: "success",
  partial: "warning",
  gap: "danger",
  unknown: "neutral",
  high: "danger",
  medium: "warning",
  low: "neutral",
} as const;

export function StatusPill({ status, label }: { status: string; label: string }) {
  const variant =
    status in STATUS_VARIANT
      ? STATUS_VARIANT[status as keyof typeof STATUS_VARIANT]
      : "neutral";
  return <Badge variant={variant}>{label}</Badge>;
}

export function ScoreRow({
  label,
  value,
  hint,
  inverted,
}: {
  label: string;
  value: number;
  hint?: string;
  /** True when a HIGH value is bad (contract risk) — colors the bar. */
  inverted?: boolean;
}) {
  const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-44 shrink-0 text-muted-foreground">
        {label}
        {hint && <span className="text-muted-foreground/60"> ({hint})</span>}
      </span>
      <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
        <span
          className={cn(
            "block h-full rounded-full",
            inverted
              ? percent >= 66
                ? "bg-rose-500"
                : percent >= 33
                  ? "bg-amber-500"
                  : "bg-emerald-500"
              : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="w-9 shrink-0 text-right tabular-nums text-foreground">
        {percent}%
      </span>
    </div>
  );
}
