/**
 * Works out where each migrated tender should sit on the new kanban board.
 *
 * Three legacy tables describe overlapping opinions about the same tender and
 * they disagree: 46 of 53 saved tenders are also on a board, 6 disliked ones
 * are on a board too, and 4 are both saved and disliked. The new model allows
 * exactly one decision per (company, tender) — there is a unique index on the
 * pair — so this resolves the conflicts in one place, deterministically.
 *
 * `company_tenders` is deliberately NOT a source. Its `workflow_status` is the
 * constant "bewertung" across all 6,029 cohort rows, so it carries no signal;
 * it is the AI matching table, not a record of anything a user decided.
 *
 * Pure: the script does the I/O and the legacy-id translation.
 */
import { DECISION_STATUSES, HIDDEN_STATUSES } from "../tenders/pipeline-status.ts";

type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Legacy board card. */
export interface WorkspaceTenderRow {
  tender_id: string | null;
  work_space_id: string | null;
  user_id?: string | null;
  assignTo?: string | null;
  tender_progress_status?: string | null;
  tender_for?: string | null;
  is_active?: boolean | null;
  deleted_at?: string | null;
  added_at?: string | null;
  updated_at?: string | null;
}

/** Legacy saved / disliked row. */
export interface SimpleTenderRef {
  tender_id: string | null;
  company_id: string | null;
  user_id?: string | null;
  created_at?: string | null;
}

export interface DecisionDraft {
  legacyCompanyId: string;
  legacyTenderId: string;
  status: DecisionStatus;
  legacyDecidedByUserId: string | null;
  legacyAssigneeUserId: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** Which legacy table won, for the report. */
  source: "workspace" | "saved" | "disliked";
}

/**
 * The legacy board labels map one-to-one onto the new pipeline statuses, which
 * is the happy case — no invented meaning.
 */
const PROGRESS_STATUS: Record<string, DecisionStatus> = {
  interested: "interested",
  preparing: "preparing",
  submitted: "submitted",
  won: "won",
  lost: "lost",
};

export function mapProgressStatus(value: unknown): DecisionStatus | null {
  if (typeof value !== "string") return null;
  return PROGRESS_STATUS[value.trim().toLowerCase()] ?? null;
}

const toDate = (value: unknown): Date | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/** A card the user removed from the board. */
export function isRemoved(row: WorkspaceTenderRow): boolean {
  return Boolean(row.deleted_at) || row.is_active === false;
}

/**
 * Picks one card when a company added the same tender repeatedly — one pair has
 * 19 rows. A card still on the board beats a removed one; otherwise the most
 * recently touched wins.
 */
export function pickWorkspaceRow(rows: WorkspaceTenderRow[]): WorkspaceTenderRow {
  return [...rows].sort((a, b) => {
    const removedGap = Number(isRemoved(a)) - Number(isRemoved(b));
    if (removedGap !== 0) return removedGap;
    const left = toDate(a.updated_at ?? a.added_at)?.getTime() ?? 0;
    const right = toDate(b.updated_at ?? b.added_at)?.getTime() ?? 0;
    return right - left;
  })[0];
}

export interface ResolveInput {
  /** Board cards, already filtered to the cohort, with their company resolved. */
  workspace: Array<{ companyId: string; row: WorkspaceTenderRow }>;
  saved: SimpleTenderRef[];
  disliked: SimpleTenderRef[];
}

/**
 * Produces at most one decision per (company, tender).
 *
 * Priority is board > saved > disliked: an explicit column the user dragged a
 * tender into is a stronger statement than a bookmark, and a bookmark is a
 * stronger statement than a dismissal (4 tenders are both, and the user
 * evidently wanted to keep them).
 */
export function resolveDecisions(input: ResolveInput): DecisionDraft[] {
  const drafts = new Map<string, DecisionDraft>();
  const key = (companyId: string, tenderId: string) => `${companyId}|${tenderId}`;

  // 1. Board cards, collapsing duplicates first.
  const byPair = new Map<string, Array<{ companyId: string; row: WorkspaceTenderRow }>>();
  for (const entry of input.workspace) {
    // `clara_doc` cards point at a chat document, not a tender.
    if (entry.row.tender_for && entry.row.tender_for !== "tender") continue;
    if (!entry.row.tender_id) continue;
    const pair = key(entry.companyId, entry.row.tender_id);
    byPair.set(pair, [...(byPair.get(pair) ?? []), entry]);
  }

  for (const [pair, entries] of byPair) {
    const winner = pickWorkspaceRow(entries.map((entry) => entry.row));
    const companyId = entries[0].companyId;
    const status = isRemoved(winner)
      ? // Legacy removal was reversible (it kept restored_at/restored_by), so
        // the recoverable status is the faithful match — never `deleted`,
        // which the product offers no way back from.
        "deadzone"
      : (mapProgressStatus(winner.tender_progress_status) ?? "interested");

    drafts.set(pair, {
      legacyCompanyId: companyId,
      legacyTenderId: winner.tender_id!,
      status,
      legacyDecidedByUserId: winner.user_id ?? null,
      legacyAssigneeUserId: winner.assignTo ?? null,
      createdAt: toDate(winner.added_at),
      updatedAt: toDate(winner.updated_at ?? winner.added_at),
      source: "workspace",
    });
  }

  // 2. Saved tenders that never made it onto a board.
  for (const row of input.saved) {
    if (!row.tender_id || !row.company_id) continue;
    const pair = key(row.company_id, row.tender_id);
    if (drafts.has(pair)) continue;
    drafts.set(pair, {
      legacyCompanyId: row.company_id,
      legacyTenderId: row.tender_id,
      status: "interested",
      legacyDecidedByUserId: row.user_id ?? null,
      legacyAssigneeUserId: null,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.created_at),
      source: "saved",
    });
  }

  // 3. Dismissals, which lose to everything above.
  for (const row of input.disliked) {
    if (!row.tender_id || !row.company_id) continue;
    const pair = key(row.company_id, row.tender_id);
    if (drafts.has(pair)) continue;
    drafts.set(pair, {
      legacyCompanyId: row.company_id,
      legacyTenderId: row.tender_id,
      status: "deadzone",
      legacyDecidedByUserId: row.user_id ?? null,
      legacyAssigneeUserId: null,
      createdAt: toDate(row.created_at),
      updatedAt: toDate(row.created_at),
      source: "disliked",
    });
  }

  return [...drafts.values()];
}

const SOURCE_RANK: Record<DecisionDraft["source"], number> = {
  workspace: 0,
  saved: 1,
  disliked: 2,
};

/**
 * Chooses between drafts that turn out to describe the same tender.
 *
 * `resolveDecisions` can only dedupe by the legacy tender uuid, but the legacy
 * database holds several rows for one notice, so two different uuids routinely
 * resolve to a single tender in the new corpus — 26 groups across the cohort,
 * 7 of them disagreeing (an active board card versus a dismissal of the same
 * tender). Without this the winner is whichever upsert happened to run last,
 * which is both arbitrary and unstable between runs.
 *
 * Order: an explicit board card beats a bookmark beats a dismissal; a live
 * status beats a hidden one; the most recently touched breaks the remaining tie.
 */
export function pickBestDraft(drafts: DecisionDraft[]): DecisionDraft {
  const hidden = (status: DecisionStatus) =>
    (HIDDEN_STATUSES as readonly string[]).includes(status);

  return [...drafts].sort((a, b) => {
    const sourceGap = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
    if (sourceGap !== 0) return sourceGap;
    const hiddenGap = Number(hidden(a.status)) - Number(hidden(b.status));
    if (hiddenGap !== 0) return hiddenGap;
    return (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0);
  })[0];
}
