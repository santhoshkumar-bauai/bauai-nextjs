import { describe, expect, it } from "vitest";

import { MAX_TENDER_REFS, TenderRefCollector } from "./tender-refs.ts";

const ID = "a".repeat(24);

describe("TenderRefCollector", () => {
  it("fills the blanks a later tool knows without losing the first tool's facts", () => {
    const refs = new TenderRefCollector();
    refs.add({ tenderId: ID, title: "Neubau Kita", buyer: "Stadt X" });
    refs.add({ tenderId: ID, decision: "bid", hasReport: true });

    expect(refs.list()).toEqual([
      expect.objectContaining({
        tenderId: ID,
        title: "Neubau Kita",
        buyer: "Stadt X",
        decision: "bid",
        hasReport: true,
      }),
    ]);
  });

  it("keeps one card per tender, in the order the tools surfaced them", () => {
    const refs = new TenderRefCollector();
    refs.add({ tenderId: ID, title: "First" });
    refs.add({ tenderId: "b".repeat(24), title: "Second" });
    refs.add({ tenderId: ID, title: "Ignored — already titled" });

    expect(refs.list().map((ref) => ref.title)).toEqual(["First", "Second"]);
  });

  it("caps new tenders but still enriches the ones already collected", () => {
    const refs = new TenderRefCollector();
    for (let index = 0; index < MAX_TENDER_REFS + 5; index += 1) {
      refs.add({ tenderId: String(index).padStart(24, "0"), title: `T${index}` });
    }
    expect(refs.list()).toHaveLength(MAX_TENDER_REFS);

    refs.add({ tenderId: "0".repeat(24), decision: "no_bid" });
    expect(refs.list()[0].decision).toBe("no_bid");
  });

  it("drains only what changed, so the stream stays quiet on re-reads", () => {
    const refs = new TenderRefCollector();
    refs.add({ tenderId: ID, title: "Neubau Kita" });
    expect(refs.drain()).toHaveLength(1);
    expect(refs.drain()).toEqual([]);

    // A tool re-reading the same tender emits nothing new…
    refs.add({ tenderId: ID, title: "Neubau Kita" });
    expect(refs.drain()).toEqual([]);

    // …but new information does.
    refs.add({ tenderId: ID, workspaceStatus: "preparing" });
    expect(refs.drain()).toEqual([
      expect.objectContaining({ workspaceStatus: "preparing" }),
    ]);
    // Draining never empties the turn's list — history keeps every card.
    expect(refs.list()).toHaveLength(1);
  });
});
