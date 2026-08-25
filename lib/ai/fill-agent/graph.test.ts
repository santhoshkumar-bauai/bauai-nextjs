import { describe, expect, it, vi } from "vitest";

import type { CompiledAgentGraph } from "../agent/service.ts";
import { fillAgentRecursionLimit, withRecursionLimit } from "./graph.ts";

describe("fill-agent recursion limit (docs/agentic-ai/06-review §6.1)", () => {
  // The tool loop takes 2 supersteps per iteration plus begin/finalize; the
  // LangGraph default of 25 would throw GraphRecursionError mid repair-loop
  // and surface to the user as a bare "failed". The wrapper must always
  // clear the worst-case superstep count.
  it("limit clears the worst-case superstep count for the iteration cap", () => {
    for (const maxIterations of [1, 8, 12, 20]) {
      expect(fillAgentRecursionLimit(maxIterations)).toBeGreaterThanOrEqual(
        2 * maxIterations + 2,
      );
    }
  });

  it("withRecursionLimit injects the limit and overrides caller-passed ones", async () => {
    const seen: Array<Record<string, unknown>> = [];
    async function* empty() {}
    const inner: CompiledAgentGraph = {
      streamEvents: (_input, options) => {
        seen.push(options as Record<string, unknown>);
        return empty() as never;
      },
    };
    const wrapped = withRecursionLimit(inner, 28);

    wrapped.streamEvents({ messages: [] }, { version: "v2" });
    expect(seen[0]).toMatchObject({ version: "v2", recursionLimit: 28 });

    wrapped.streamEvents(
      { messages: [] },
      { version: "v2", recursionLimit: 5 } as never,
    );
    expect(seen[1]?.recursionLimit).toBe(28);
  });

  it("default env yields a limit above LangGraph's default of 25", () => {
    expect(fillAgentRecursionLimit(12)).toBeGreaterThan(25);
  });

  it("keeps the wrapper honest if someone swaps argument order", () => {
    const spy = vi.fn(() => (async function* () {})() as never);
    withRecursionLimit({ streamEvents: spy }, 99).streamEvents(
      { messages: [] },
      { version: "v2" },
    );
    expect(spy).toHaveBeenCalledWith(
      { messages: [] },
      expect.objectContaining({ recursionLimit: 99 }),
    );
  });
});
