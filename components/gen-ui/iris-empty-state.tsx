"use client";

import { useTranslations } from "next-intl";

import { BLOCK_ICONS } from "./block-shell";
import { useIrisActions } from "./iris-context";

/**
 * The opening screen: not "how can I help", but a gallery of what this agent
 * can DRAW.
 *
 * A generative-UI agent has a discovery problem no chat agent has. The user
 * cannot guess that asking about deadlines produces a timeline and asking
 * about two tenders produces a comparison table — and if they never find out,
 * the surface degrades into a slower chat. Each card names the view and sends
 * the prompt that produces it, so the first turn teaches the vocabulary.
 */

const SHOWCASE = [
  { kind: "metric-summary", key: "metrics" },
  { kind: "tender-grid", key: "feed" },
  { kind: "tender-compare", key: "compare" },
  { kind: "bid-verdict", key: "verdict" },
  { kind: "requirement-checklist", key: "requirements" },
  { kind: "pipeline-board", key: "board" },
] as const;

export function IrisEmptyState({ companyName }: { companyName: string }) {
  const t = useTranslations("GenUi.empty");
  const { sendPrompt, isStreaming } = useIrisActions();

  return (
    <div className="mx-auto max-w-2xl px-1 py-10">
      <p className="text-[11px] font-semibold tracking-[0.14em] text-primary uppercase">
        {t("eyebrow")}
      </p>
      <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
        {t("greeting", { company: companyName })}
      </h2>
      <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted-foreground">
        {t("lede")}
      </p>

      <div className="mt-6 grid gap-2 sm:grid-cols-2">
        {SHOWCASE.map((entry) => {
          const Icon = BLOCK_ICONS[entry.kind];
          return (
            <button
              key={entry.key}
              type="button"
              disabled={isStreaming}
              onClick={() => sendPrompt(t(`cards.${entry.key}.prompt` as "cards.feed.prompt"))}
              className="group flex items-start gap-2.5 rounded-xl border border-border bg-card p-3 text-left transition-all hover:border-primary/40 hover:shadow-[0_2px_10px_rgba(80,0,168,0.06)] disabled:opacity-60"
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                <Icon className="size-3.5" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground">
                  {t(`cards.${entry.key}.title` as "cards.feed.title")}
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  {t(`cards.${entry.key}.detail` as "cards.feed.detail")}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <p className="mt-5 text-[11px] text-muted-foreground">{t("footnote")}</p>
    </div>
  );
}
