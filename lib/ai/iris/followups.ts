import type { BlockKind } from "./blocks.ts";
import type { IrisFollowups } from "./wire.ts";
import type { IrisLocale } from "./strings.ts";

/**
 * Next-step chips, derived from what the turn actually rendered.
 *
 * Deliberately deterministic rather than model-authored. A suggestion is a
 * promise that the next turn will work, and the model does not know which
 * tenders have a verdict behind them — the blocks do. Deriving them from the
 * rendered kinds means a chip never leads to an empty panel, and it costs no
 * tokens.
 */

type Suggestion = { en: [string, string]; de: [string, string] };

/** [label, prompt] per locale. `{id}` is substituted with a real tender id. */
const BY_KIND: Partial<Record<BlockKind, Suggestion[]>> = {
  "metric-summary": [
    {
      en: ["Show what's closing", "Show the opportunities closing in the next 7 days"],
      de: ["Was läuft aus?", "Zeig die Ausschreibungen, deren Frist in 7 Tagen endet"],
    },
    {
      en: ["Open my board", "Show my bid pipeline"],
      de: ["Board öffnen", "Zeig meine Bid-Pipeline"],
    },
  ],
  "tender-grid": [
    {
      en: ["Compare the top 3", "Compare the top three of those side by side"],
      de: ["Top 3 vergleichen", "Vergleiche die besten drei davon nebeneinander"],
    },
    {
      en: ["Narrow this down", "Let me narrow these results down"],
      de: ["Eingrenzen", "Lass mich diese Treffer eingrenzen"],
    },
  ],
  "tender-spotlight": [
    {
      en: ["Should we bid?", "Should we bid on {id}?"],
      de: ["Sollen wir bieten?", "Sollen wir auf {id} bieten?"],
    },
    {
      en: ["What do they require?", "What are the requirements for {id}?"],
      de: ["Was wird gefordert?", "Welche Anforderungen stellt {id}?"],
    },
    {
      en: ["Key dates", "Show the timeline for {id}"],
      de: ["Termine", "Zeig den Zeitplan für {id}"],
    },
  ],
  "bid-verdict": [
    {
      en: ["Where is that stated?", "Show me the passages behind those risks for {id}"],
      de: ["Wo steht das?", "Zeig mir die Belegstellen zu diesen Risiken für {id}"],
    },
    {
      en: ["Check the requirements", "Show the requirement checklist for {id}"],
      de: ["Anforderungen prüfen", "Zeig die Anforderungs-Checkliste für {id}"],
    },
  ],
  "requirement-checklist": [
    {
      en: ["What can we prove?", "Which of our company documents cover these requirements?"],
      de: ["Was können wir belegen?", "Welche unserer Firmendokumente decken diese Anforderungen ab?"],
    },
  ],
  "pipeline-board": [
    {
      en: ["What's most urgent?", "Which board item is most urgent right now?"],
      de: ["Was ist am dringendsten?", "Welche Position auf dem Board ist gerade am dringendsten?"],
    },
  ],
  "evidence-panel": [
    {
      en: ["Summarise the risk", "What does that mean for our bid?"],
      de: ["Risiko einordnen", "Was bedeutet das für unser Angebot?"],
    },
  ],
  "company-snapshot": [
    {
      en: ["Find matching work", "Find tenders that match this profile"],
      de: ["Passende Aufträge", "Finde Ausschreibungen, die zu diesem Profil passen"],
    },
  ],
};

/** Blocks that ARE the question — appending chips beside them competes. */
const SUPPRESSED: readonly BlockKind[] = ["choice-prompt", "filter-refine"];

const OPENERS: Suggestion[] = [
  {
    en: ["How are we doing?", "Give me the portfolio overview"],
    de: ["Wie stehen wir da?", "Gib mir die Portfolio-Übersicht"],
  },
  {
    en: ["What should we bid on?", "What should we bid on this week?"],
    de: ["Worauf sollen wir bieten?", "Worauf sollten wir diese Woche bieten?"],
  },
];

export function buildFollowups(input: {
  locale: IrisLocale;
  renderedKinds: BlockKind[];
  /** A tender id from this turn, so a chip can name a real target. */
  focusTenderId: string | null;
}): IrisFollowups {
  if (input.renderedKinds.some((kind) => SUPPRESSED.includes(kind))) {
    return { suggestions: [] };
  }

  const pool: Suggestion[] = [];
  for (const kind of input.renderedKinds) {
    for (const entry of BY_KIND[kind] ?? []) {
      if (!pool.includes(entry)) pool.push(entry);
    }
  }
  const chosen = pool.length > 0 ? pool : OPENERS;

  return {
    suggestions: chosen
      .map((entry) => {
        const [label, prompt] = entry[input.locale];
        return { label, prompt };
      })
      // A chip that still says "{id}" has no tender to point at, so it would
      // send a literal placeholder as the user's next message.
      .flatMap((suggestion) => {
        if (!suggestion.prompt.includes("{id}")) return [suggestion];
        if (!input.focusTenderId) return [];
        return [{ ...suggestion, prompt: suggestion.prompt.replace("{id}", input.focusTenderId) }];
      })
      .slice(0, 3),
  };
}
