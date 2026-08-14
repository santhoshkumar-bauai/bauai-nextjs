import { describe, expect, it } from "vitest";

import { MAX_UI_CALLS, UiCallCollector } from "./ui-calls.ts";

describe("UiCallCollector", () => {
  it("reuses ids when the SAME turn replays, so nothing runs twice", () => {
    const first = new UiCallCollector();
    first.setTurnKey("msg-1");
    first.add({ action: "navigateTo", args: { milestoneId: "ask_clara" } });
    first.add({ action: "highlightElement", args: { milestoneId: "ask_clara" } });

    // A checkpoint replay builds a fresh collector and re-runs the same tools;
    // identical ids are what lets the client skip work it already did.
    const replay = new UiCallCollector();
    replay.setTurnKey("msg-1");
    replay.add({ action: "navigateTo", args: { milestoneId: "ask_clara" } });
    replay.add({ action: "highlightElement", args: { milestoneId: "ask_clara" } });

    expect(first.list().map((call) => call.id)).toEqual(["msg-1-1", "msg-1-2"]);
    expect(replay.list().map((call) => call.id)).toEqual(["msg-1-1", "msg-1-2"]);
  });

  it("gives DIFFERENT turns different ids", () => {
    // Regression: both turns used to emit "ui-1", and the client de-duplicates
    // for the whole session — so only the first tour of a session ever ran.
    const turnOne = new UiCallCollector();
    turnOne.setTurnKey("msg-1");
    turnOne.add({ action: "startMilestoneTour", args: {} });

    const turnTwo = new UiCallCollector();
    turnTwo.setTurnKey("msg-2");
    turnTwo.add({ action: "startMilestoneTour", args: {} });

    expect(turnOne.list()[0].id).not.toBe(turnTwo.list()[0].id);
  });

  it("drains only what is new, then empties", () => {
    const collector = new UiCallCollector();
    collector.add({ action: "navigateTo", args: {} });

    expect(collector.drain().map((call) => call.action)).toEqual(["navigateTo"]);
    expect(collector.drain()).toEqual([]);

    collector.add({ action: "highlightElement", args: {} });
    expect(collector.drain().map((call) => call.action)).toEqual(["highlightElement"]);
  });

  it("keeps the full turn in list() after draining", () => {
    const collector = new UiCallCollector();
    collector.add({ action: "navigateTo", args: {} });
    collector.drain();
    collector.add({ action: "highlightElement", args: {} });

    expect(collector.list()).toHaveLength(2);
  });

  it("caps a turn's calls and reports the rejection to the tool", () => {
    const collector = new UiCallCollector();
    for (let i = 0; i < MAX_UI_CALLS; i += 1) {
      expect(collector.add({ action: "navigateTo", args: { i } })).not.toBeNull();
    }

    expect(collector.add({ action: "navigateTo", args: { over: true } })).toBeNull();
    expect(collector.list()).toHaveLength(MAX_UI_CALLS);
  });
});
