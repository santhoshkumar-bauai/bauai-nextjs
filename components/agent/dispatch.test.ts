import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { WireUiCall } from "@/lib/ai/agent/wire";
import {
  dispatchUiCalls,
  type AgentActionFailure,
  type RegisteredAction,
} from "./dispatch";

function call(action: string, args: unknown, id = "ui-1"): WireUiCall {
  return { id, action, args };
}

function registry(entries: Record<string, RegisteredAction>) {
  return (name: string) => entries[name];
}

/** An action whose args must be a known milestone id. */
function milestoneAction(run: (args: { milestoneId: string }) => void) {
  return {
    schema: z.object({ milestoneId: z.enum(["save_first_tender", "ask_clara"]) }),
    run: run as (args: unknown) => void,
  } satisfies RegisteredAction;
}

describe("dispatchUiCalls", () => {
  it("runs a registered action with parsed args", async () => {
    const run = vi.fn();
    await dispatchUiCalls({
      calls: [call("startMilestoneTour", { milestoneId: "ask_clara" })],
      resolve: registry({ startMilestoneTour: milestoneAction(run) }),
      executed: new Set(),
    });

    expect(run).toHaveBeenCalledWith({ milestoneId: "ask_clara" });
  });

  it("drops an unknown action and reports it", async () => {
    const failures: AgentActionFailure[] = [];
    await dispatchUiCalls({
      calls: [call("deleteEverything", {})],
      resolve: registry({}),
      executed: new Set(),
      onFailure: (failure) => failures.push(failure),
    });

    expect(failures).toEqual([
      { reason: "unknown_action", action: "deleteEverything" },
    ]);
  });

  it("rejects args the schema does not accept", async () => {
    const run = vi.fn();
    const failures: AgentActionFailure[] = [];
    // A milestone id the registry never defined — the model hallucinating a
    // step is the exact drift this gate exists to catch.
    await dispatchUiCalls({
      calls: [call("startMilestoneTour", { milestoneId: "invent_a_step" })],
      resolve: registry({ startMilestoneTour: milestoneAction(run) }),
      executed: new Set(),
      onFailure: (failure) => failures.push(failure),
    });

    expect(run).not.toHaveBeenCalled();
    expect(failures[0]?.reason).toBe("invalid_args");
    expect(failures[0]).toMatchObject({ action: "startMilestoneTour" });
  });

  it("does not let a throwing handler escape", async () => {
    const failures: AgentActionFailure[] = [];
    await expect(
      dispatchUiCalls({
        calls: [call("startMilestoneTour", { milestoneId: "ask_clara" })],
        resolve: registry({
          startMilestoneTour: milestoneAction(() => {
            throw new Error("router unavailable");
          }),
        }),
        executed: new Set(),
        onFailure: (failure) => failures.push(failure),
      }),
    ).resolves.toBeUndefined();

    expect(failures[0]).toEqual({
      reason: "handler_threw",
      action: "startMilestoneTour",
      detail: "router unavailable",
    });
  });

  it("runs a given call id only once, so a resumed turn cannot repeat it", async () => {
    const run = vi.fn();
    const executed = new Set<string>();
    const resolve = registry({ startMilestoneTour: milestoneAction(run) });
    const replay = [call("startMilestoneTour", { milestoneId: "ask_clara" }, "ui-7")];

    await dispatchUiCalls({ calls: replay, resolve, executed });
    await dispatchUiCalls({ calls: replay, resolve, executed });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("keeps going after a bad call so one failure cannot strand the rest", async () => {
    const run = vi.fn();
    await dispatchUiCalls({
      calls: [
        call("missing", {}, "ui-1"),
        call("startMilestoneTour", { milestoneId: "nope" }, "ui-2"),
        call("startMilestoneTour", { milestoneId: "ask_clara" }, "ui-3"),
      ],
      resolve: registry({ startMilestoneTour: milestoneAction(run) }),
      executed: new Set(),
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith({ milestoneId: "ask_clara" });
  });
});
