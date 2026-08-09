import type { WireTenderRef } from "./wire.ts";

/**
 * Per-turn tender collector — the citation collector's sibling for navigation.
 *
 * Tools hand their tenders to the MODEL as JSON; the model then writes prose
 * that names them by title. Nothing in that text is addressable, so the UI
 * would have to guess which tenders an answer is about (or scrape 24-char ids
 * out of it) to offer a link. Instead every tool that surfaces a tender
 * registers it here, and the finished message carries the list — rendered as
 * cards the reader can click through to the tender's own page.
 *
 * Entries MERGE by id: find_tenders may surface a tender that
 * list_tender_reports later annotates with a decision, and the card should
 * show both. Merging keeps the first non-null value for descriptive fields and
 * lets later tools fill in what they alone know.
 */

/** More cards than this is a wall, not a shortcut. */
export const MAX_TENDER_REFS = 12;

export type TenderRef = WireTenderRef;

export type TenderRefInput = { tenderId: string } & Partial<
  Omit<TenderRef, "tenderId">
>;

export class TenderRefCollector {
  private readonly byId = new Map<string, TenderRef>();
  /** Ids added or enriched since the last drain(); powers the live stream. */
  private readonly dirty = new Set<string>();

  add(input: TenderRefInput): void {
    const existing = this.byId.get(input.tenderId);
    // The cap bounds new tenders only — enriching a card already shown is free.
    if (!existing && this.byId.size >= MAX_TENDER_REFS) return;

    // First writer wins per field; later tools only fill in what they alone
    // know. Two tools describing the same tender must not make the card flip
    // between their two views of it mid-turn.
    const merged: TenderRef = {
      tenderId: input.tenderId,
      title: existing?.title ?? input.title ?? null,
      buyer: existing?.buyer ?? input.buyer ?? null,
      status: existing?.status ?? input.status ?? null,
      submissionDeadline:
        existing?.submissionDeadline ?? input.submissionDeadline ?? null,
      daysUntilDeadline:
        existing?.daysUntilDeadline ?? input.daysUntilDeadline ?? null,
      workspaceStatus: existing?.workspaceStatus ?? input.workspaceStatus ?? null,
      decision: existing?.decision ?? input.decision ?? null,
      matchScore: existing?.matchScore ?? input.matchScore ?? null,
      hasReport: existing?.hasReport || input.hasReport || false,
    };
    // A tool re-reading the same tender must not re-emit an identical card.
    if (existing && shallowEqual(existing, merged)) return;

    this.byId.set(input.tenderId, merged);
    this.dirty.add(input.tenderId);
  }

  /** Everything collected this turn, in the order the tools surfaced it. */
  list(): TenderRef[] {
    return [...this.byId.values()];
  }

  /** New or changed entries since the previous call; empties the queue. */
  drain(): TenderRef[] {
    if (this.dirty.size === 0) return [];
    const refs = [...this.dirty].flatMap((id) => {
      const ref = this.byId.get(id);
      return ref ? [ref] : [];
    });
    this.dirty.clear();
    return refs;
  }
}

function shallowEqual(left: TenderRef, right: TenderRef): boolean {
  return (Object.keys(left) as Array<keyof TenderRef>).every(
    (key) => left[key] === right[key],
  );
}
