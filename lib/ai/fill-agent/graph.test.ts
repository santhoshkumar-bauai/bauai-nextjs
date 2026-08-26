import { describe, expect, it } from "vitest";

import { toolLoopRecursionLimit } from "../agent/tool-loop.ts";
import { fillAgentRecursionLimit } from "./graph.ts";

/**
 * docs/agentic-ai/06-review §6.1.
 *
 * The tool loop takes 2 supersteps per iteration plus begin/finalize, and
 * LangGraph's default limit is 25 — which every agent here was within three
 * supersteps of. Exceeding it throws GraphRecursionError mid-run and used to
 * surface as a bare "failed". `runChatTurn` now sets a limit for every graph;
 * these tests pin the arithmetic so raising an iteration cap fails CI instead
 * of production.
 */
describe("recursion limits", () => {
  it("clears the worst-case superstep count for any iteration cap", () => {
    for (const maxIterations of [1, 8, 10, 12, 20]) {
      // beginTurn + n × (model, tools) + model + finalize
      const worstCase = 2 * maxIterations + 3;
      expect(toolLoopRecursionLimit(maxIterations)).toBeGreaterThanOrEqual(worstCase);
    }
  });

  it("accounts for host graphs that wrap the loop", () => {
    // Otto's worst path adds plan, verify, an auto-advance guide and a second
    // finalize around the shared loop.
    expect(toolLoopRecursionLimit(8, 4)).toBeGreaterThan(toolLoopRecursionLimit(8));
    expect(toolLoopRecursionLimit(8, 4)).toBeGreaterThanOrEqual(2 * 8 + 4 + 4);
  });

  it("beats LangGraph's default of 25 at the caps we actually ship", () => {
    // Clara global chat (10) and the fill agent (12) both sat under 25 before.
    expect(toolLoopRecursionLimit(10, 4)).toBeGreaterThan(25);
    expect(fillAgentRecursionLimit(12)).toBeGreaterThan(25);
  });

  it("keeps the fill agent's limit derived from the shared formula", () => {
    // It used to have its own copy of the arithmetic, which is exactly how the
    // two drift apart.
    expect(fillAgentRecursionLimit(9)).toBe(toolLoopRecursionLimit(9));
  });
});
