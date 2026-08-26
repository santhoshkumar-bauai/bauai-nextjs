import { describe, expect, it } from "vitest";

import type { BlockPayload } from "./blocks.ts";
import { BlockEmitter, MAX_BLOCKS_PER_TURN, type BlockEvent } from "./emitter.ts";

/**
 * The emitter is the one place where a bad block can reach a browser, and the
 * one place where a replayed turn can duplicate a grid. Both are covered here.
 */

const GRID: BlockPayload<"tender-grid"> = {
  title: "Matched",
  items: [{ tenderId: "a".repeat(24), title: "Road works", buyer: "Stadt Berlin" }],
};

function collect(emitter: BlockEmitter): BlockEvent[] {
  const events: BlockEvent[] = [];
  emitter.subscribe((event) => events.push(event));
  return events;
}

describe("BlockEmitter", () => {
  it("emits loading immediately and ready under the same id", () => {
    const emitter = new BlockEmitter();
    const events = collect(emitter);

    const handle = emitter.open("tender-grid", "Matched")!;
    expect(events).toHaveLength(1);
    expect(events[0].state.status).toBe("loading");

    expect(handle.ready(GRID)).toBe(true);
    expect(events).toHaveLength(2);
    expect(events[1].state.status).toBe("ready");
    // Same id both times, or the client stacks a skeleton and a grid instead
    // of reconciling one into the other.
    expect(events[1].id).toBe(events[0].id);
  });

  it("namespaces ids by turn key so a second turn cannot overwrite the first", () => {
    const first = new BlockEmitter();
    first.setTurnKey("msg-1");
    const firstEvents = collect(first);
    first.open("tender-grid");

    const second = new BlockEmitter();
    second.setTurnKey("msg-2");
    const secondEvents = collect(second);
    second.open("tender-grid");

    expect(firstEvents[0].id).toBe("msg-1-1");
    expect(secondEvents[0].id).toBe("msg-2-1");
  });

  it("drops a payload that fails its catalog schema", () => {
    const emitter = new BlockEmitter();
    const events = collect(emitter);

    const handle = emitter.open("tender-grid")!;
    // `items` entries need a tenderId; a half-built block must never render.
    expect(handle.ready({ title: "Broken", items: [{}] } as never)).toBe(false);
    expect(events[1].state).toMatchObject({ status: "error", message: "invalid_block" });
    expect(emitter.renderedKinds()).toEqual([]);
  });

  it("settles once — a late fail after ready is ignored", () => {
    const emitter = new BlockEmitter();
    const events = collect(emitter);

    const handle = emitter.open("tender-grid")!;
    handle.ready(GRID);
    handle.fail("too late");

    expect(events).toHaveLength(2);
    expect(events[1].state.status).toBe("ready");
  });

  it("caps blocks per turn and reports the cap to the caller", () => {
    const emitter = new BlockEmitter();
    for (let index = 0; index < MAX_BLOCKS_PER_TURN; index += 1) {
      expect(emitter.open("tender-grid")).not.toBeNull();
    }
    expect(emitter.open("tender-grid")).toBeNull();
  });

  it("counts only blocks that actually rendered", () => {
    const emitter = new BlockEmitter();
    emitter.open("tender-grid")!.ready(GRID);
    emitter.open("bid-verdict")!.fail("no verdict yet");

    expect(emitter.renderedKinds()).toEqual(["tender-grid"]);
  });
});
