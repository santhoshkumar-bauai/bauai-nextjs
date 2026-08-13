import { describe, expect, it } from "vitest";

import {
  type DecisionDraft,
  type WorkspaceTenderRow,
  isRemoved,
  mapProgressStatus,
  pickBestDraft,
  pickWorkspaceRow,
  resolveDecisions,
} from "./decisions.ts";

function card(overrides: Partial<WorkspaceTenderRow> = {}): WorkspaceTenderRow {
  return {
    tender_id: "t1",
    work_space_id: "w1",
    user_id: "u1",
    tender_progress_status: "Interested",
    tender_for: "tender",
    is_active: true,
    deleted_at: null,
    added_at: "2026-01-17T13:05:58Z",
    updated_at: "2026-01-17T13:05:58Z",
    ...overrides,
  };
}

describe("mapProgressStatus", () => {
  it("maps every legacy board label onto a pipeline status", () => {
    // These five are the only values present across the cohort's 412 cards.
    expect(mapProgressStatus("Interested")).toBe("interested");
    expect(mapProgressStatus("Preparing")).toBe("preparing");
    expect(mapProgressStatus("Submitted")).toBe("submitted");
    expect(mapProgressStatus("Won")).toBe("won");
    expect(mapProgressStatus("Lost")).toBe("lost");
  });

  it("returns null for anything unrecognised rather than guessing", () => {
    expect(mapProgressStatus("bewertung")).toBeNull();
    expect(mapProgressStatus(null)).toBeNull();
    expect(mapProgressStatus("")).toBeNull();
  });
});

describe("isRemoved / pickWorkspaceRow", () => {
  it("treats a deleted or deactivated card as removed", () => {
    expect(isRemoved(card({ deleted_at: "2026-02-01T00:00:00Z" }))).toBe(true);
    expect(isRemoved(card({ is_active: false }))).toBe(true);
    expect(isRemoved(card())).toBe(false);
  });

  it("prefers a card still on the board over a removed one", () => {
    const chosen = pickWorkspaceRow([
      card({ tender_progress_status: "Lost", deleted_at: "2026-03-01T00:00:00Z", updated_at: "2026-06-01T00:00:00Z" }),
      card({ tender_progress_status: "Won", updated_at: "2026-01-01T00:00:00Z" }),
    ]);
    expect(chosen.tender_progress_status).toBe("Won");
  });

  it("falls back to the most recently touched card", () => {
    // One cohort pair has 19 rows from repeated add/remove cycles.
    const chosen = pickWorkspaceRow([
      card({ tender_progress_status: "Interested", updated_at: "2026-01-01T00:00:00Z" }),
      card({ tender_progress_status: "Submitted", updated_at: "2026-05-01T00:00:00Z" }),
      card({ tender_progress_status: "Preparing", updated_at: "2026-03-01T00:00:00Z" }),
    ]);
    expect(chosen.tender_progress_status).toBe("Submitted");
  });
});

describe("resolveDecisions", () => {
  const empty = { workspace: [], saved: [], disliked: [] };

  it("produces one decision per (company, tender) despite duplicate cards", () => {
    const drafts = resolveDecisions({
      ...empty,
      workspace: [
        { companyId: "c1", row: card({ tender_progress_status: "Interested", updated_at: "2026-01-01T00:00:00Z" }) },
        { companyId: "c1", row: card({ tender_progress_status: "Won", updated_at: "2026-05-01T00:00:00Z" }) },
      ],
    });

    // The target has a unique index on the pair; two rows would fail the write.
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("won");
  });

  it("keeps a removed card recoverable instead of permanently deleting it", () => {
    // Legacy removal kept restored_at/restored_by, so it was reversible.
    const drafts = resolveDecisions({
      ...empty,
      workspace: [{ companyId: "c1", row: card({ deleted_at: "2026-02-01T00:00:00Z" }) }],
    });
    expect(drafts[0].status).toBe("deadzone");
  });

  it("ignores clara_doc cards, which point at a chat document not a tender", () => {
    const drafts = resolveDecisions({
      ...empty,
      workspace: [{ companyId: "c1", row: card({ tender_for: "clara_doc" }) }],
    });
    expect(drafts).toEqual([]);
  });

  it("lets the board outrank a bookmark for the same tender", () => {
    // 46 of the cohort's 53 saved tenders are also on a board.
    const drafts = resolveDecisions({
      ...empty,
      workspace: [{ companyId: "c1", row: card({ tender_progress_status: "Submitted" }) }],
      saved: [{ tender_id: "t1", company_id: "c1", user_id: "u9" }],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("submitted");
    expect(drafts[0].source).toBe("workspace");
  });

  it("lets a bookmark outrank a dismissal, since the user kept it", () => {
    // 4 cohort tenders are both saved and disliked.
    const drafts = resolveDecisions({
      ...empty,
      saved: [{ tender_id: "t1", company_id: "c1" }],
      disliked: [{ tender_id: "t1", company_id: "c1" }],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("interested");
    expect(drafts[0].source).toBe("saved");
  });

  it("still migrates a dismissal that nothing else covers", () => {
    const drafts = resolveDecisions({
      ...empty,
      disliked: [{ tender_id: "t2", company_id: "c1", created_at: "2026-04-01T00:00:00Z" }],
    });

    expect(drafts[0]).toMatchObject({ status: "deadzone", source: "disliked" });
    expect(drafts[0].createdAt).toEqual(new Date("2026-04-01T00:00:00Z"));
  });

  it("keeps the same tender separate for two different companies", () => {
    const drafts = resolveDecisions({
      ...empty,
      saved: [
        { tender_id: "t1", company_id: "c1" },
        { tender_id: "t1", company_id: "c2" },
      ],
    });
    expect(drafts).toHaveLength(2);
  });

  it("carries the assignee and author through for the board case", () => {
    const drafts = resolveDecisions({
      ...empty,
      workspace: [
        { companyId: "c1", row: card({ user_id: "author", assignTo: "assignee" }) },
      ],
    });

    expect(drafts[0].legacyDecidedByUserId).toBe("author");
    expect(drafts[0].legacyAssigneeUserId).toBe("assignee");
  });

  it("defaults an unrecognised board label to interested rather than dropping the card", () => {
    const drafts = resolveDecisions({
      ...empty,
      workspace: [{ companyId: "c1", row: card({ tender_progress_status: "Sonstiges" }) }],
    });
    expect(drafts[0].status).toBe("interested");
  });
});

describe("pickBestDraft", () => {
  function draft(overrides: Partial<DecisionDraft>): DecisionDraft {
    return {
      legacyCompanyId: "c1",
      legacyTenderId: "t1",
      status: "interested",
      legacyDecidedByUserId: null,
      legacyAssigneeUserId: null,
      createdAt: null,
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      source: "workspace",
      ...overrides,
    };
  }

  it("keeps an active board card over a dismissal of the same tender", () => {
    // Real conflict: two legacy tender rows resolve to one tender in the new
    // corpus, one on the board and one dismissed.
    const best = pickBestDraft([
      draft({ status: "deadzone", source: "disliked" }),
      draft({ status: "interested", source: "workspace" }),
    ]);
    expect(best.status).toBe("interested");
  });

  it("prefers a live status over a hidden one from the same source", () => {
    const best = pickBestDraft([
      draft({ status: "deadzone", updatedAt: new Date("2026-06-01T00:00:00Z") }),
      draft({ status: "preparing", updatedAt: new Date("2026-01-01T00:00:00Z") }),
    ]);
    expect(best.status).toBe("preparing");
  });

  it("breaks a remaining tie on recency", () => {
    const best = pickBestDraft([
      draft({ status: "interested", updatedAt: new Date("2026-01-01T00:00:00Z") }),
      draft({ status: "won", updatedAt: new Date("2026-07-01T00:00:00Z") }),
    ]);
    expect(best.status).toBe("won");
  });

  it("is deterministic regardless of input order", () => {
    const a = draft({ status: "deadzone", source: "disliked" });
    const b = draft({ status: "submitted", source: "workspace" });
    expect(pickBestDraft([a, b]).status).toBe(pickBestDraft([b, a]).status);
  });

  it("returns the only draft when there is no conflict", () => {
    const only = draft({ status: "lost" });
    expect(pickBestDraft([only])).toBe(only);
  });
});
