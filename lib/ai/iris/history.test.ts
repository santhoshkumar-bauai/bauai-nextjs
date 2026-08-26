import { describe, expect, it } from "vitest";

import { renderedNote, toLangChainHistory } from "./history.ts";
import type { IrisUIMessage } from "./wire.ts";

/**
 * These cover the two failure modes that only show up on turn TWO, which is
 * exactly where they are easy to ship: history that a provider rejects, and a
 * model that has forgotten what it put on screen.
 */

const message = (partial: Partial<IrisUIMessage>): IrisUIMessage =>
  ({ id: "m", role: "assistant", parts: [], ...partial }) as IrisUIMessage;

const grid = (...tenderIds: string[]) =>
  ({
    type: "data-tender-grid",
    id: "b-1",
    data: {
      status: "ready",
      kind: "tender-grid",
      block: { title: "Matched", items: tenderIds.map((tenderId) => ({ tenderId })) },
    },
  }) as unknown as IrisUIMessage["parts"][number];

describe("renderedNote", () => {
  it("names the kind and the tender ids that were on screen", () => {
    expect(renderedNote(message({ parts: [grid("aaa", "bbb")] }))).toBe(
      "\n[rendered: tender-grid[aaa,bbb]]",
    );
  });

  it("ignores blocks that never resolved", () => {
    const loading = {
      type: "data-tender-grid",
      id: "b-1",
      data: { status: "loading", kind: "tender-grid" },
    } as unknown as IrisUIMessage["parts"][number];
    const failed = {
      type: "data-bid-verdict",
      id: "b-2",
      data: { status: "error", kind: "bid-verdict", message: "no verdict yet" },
    } as unknown as IrisUIMessage["parts"][number];

    // A skeleton and an empty state are not "on screen" in any sense the
    // model can reason about, and claiming otherwise invites it to answer
    // follow-ups from a block that has no data in it.
    expect(renderedNote(message({ parts: [loading, failed] }))).toBe("");
  });

  it("falls back to the bare kind for blocks with no tenders", () => {
    const snapshot = {
      type: "data-company-snapshot",
      id: "b-1",
      data: {
        status: "ready",
        kind: "company-snapshot",
        block: { name: "Wirl", capabilities: [], cpvCodes: [], regions: [] },
      },
    } as unknown as IrisUIMessage["parts"][number];

    expect(renderedNote(message({ parts: [snapshot] }))).toBe("\n[rendered: company-snapshot]");
  });
});

describe("toLangChainHistory", () => {
  it("keeps user text and appends the rendered note to the assistant turn", () => {
    const history = toLangChainHistory([
      message({
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "what should we bid on?" }],
      }),
      message({
        id: "a1",
        parts: [{ type: "text", text: "Three close this week." }, grid("aaa", "bbb")],
      }),
    ]);

    expect(history).toHaveLength(2);
    expect(history[0].getType()).toBe("human");
    expect(history[0].content).toBe("what should we bid on?");
    expect(history[1].getType()).toBe("ai");
    expect(history[1].content).toBe("Three close this week.\n[rendered: tender-grid[aaa,bbb]]");
  });

  it("drops tool parts rather than replaying them", () => {
    const toolPart = {
      type: "tool-show_opportunity_feed",
      toolCallId: "call-1",
      state: "output-available",
      input: { limit: 6 },
      output: "{}",
    } as unknown as IrisUIMessage["parts"][number];

    const history = toLangChainHistory([
      message({ id: "a1", parts: [toolPart, { type: "text", text: "Done." }] }),
    ]);

    // One AI message with prose only. A rebuilt tool-call turn with no
    // matching tool responses is precisely the history Gemini 400s on.
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("Done.");
  });

  it("skips turns that carry nothing at all", () => {
    expect(
      toLangChainHistory([
        message({ id: "u1", role: "user", parts: [{ type: "text", text: "   " }] }),
        message({ id: "a1", parts: [] }),
      ]),
    ).toEqual([]);
  });

  it("keeps a block-only assistant turn — the block IS the answer here", () => {
    const history = toLangChainHistory([message({ id: "a1", parts: [grid("aaa")] })]);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe("[rendered: tender-grid[aaa]]");
  });
});
