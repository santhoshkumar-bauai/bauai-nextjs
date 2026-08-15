import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAiEnvCache } from "../config/env.ts";
import { CitationCollector } from "../agent/citations.ts";
import { TenderRefCollector } from "../agent/tender-refs.ts";
import { UiCallCollector } from "../agent/ui-calls.ts";
import { FakeToolCallingChatModel } from "../agent/testing.ts";
import { setAgentModelForTests } from "../agent/model.ts";
import type { MilestoneId } from "../../onboarding/milestones.ts";
import type { OttoRunContext } from "./context.ts";

/**
 * Regression cover for the three bugs that made Otto reply with nothing:
 *
 *  1. `iterations` was never reset, because the graph omitted the shared
 *     loop's `beginTurn` node. After a few turns the counter passed the cap
 *     for good and every turn short-circuited — Otto could never call a tool
 *     again, so it could never navigate or spotlight.
 *  2. The guide node reimplemented the model call and dropped the shared
 *     history hygiene, so Gemini answered a malformed history with empty text.
 *  3. The profile node set `pendingQuestion` and ended the turn without ever
 *     calling the model, persisting an empty assistant message.
 */

/** Completion is stubbed so the plan/guide path can be driven deterministically. */
const complete = new Set<MilestoneId>();
vi.mock("../../onboarding/completion.ts", () => ({
  isMilestoneComplete: async (id: MilestoneId) => complete.has(id),
  completedMilestones: async () => [...complete],
}));

vi.mock("../agent/checkpointer.ts", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getClaraCheckpointer: async () => saver };
});

vi.mock("./tools.ts", () => ({
  buildOttoTools: () => [
    {
      name: "start_milestone_tour",
      description: "test tool",
      schema: undefined,
      invoke: async () => JSON.stringify({ ok: true }),
    },
  ],
}));

vi.mock("@langchain/langgraph/prebuilt", async () => {
  const { ToolMessage } = await import("@langchain/core/messages");
  class FakeToolNode {
    async invoke(state: {
      messages: Array<{ tool_calls?: Array<{ id?: string; name: string }> }>;
    }) {
      const last = state.messages[state.messages.length - 1];
      return {
        messages: (last.tool_calls ?? []).map(
          (call) =>
            new ToolMessage({
              content: JSON.stringify({ ok: true }),
              tool_call_id: call.id ?? "t1",
              name: call.name,
            }),
        ),
      };
    }
  }
  return { ToolNode: FakeToolNode };
});

const { buildOttoGraph } = await import("./graph.ts");

function fakeCtx(): OttoRunContext {
  const tenantId = new ObjectId();
  return {
    tenantId,
    userId: "u1",
    locale: "en",
    companyContext: {} as never,
    citations: new CitationCollector(),
    tenderRefs: new TenderRefCollector(),
    uiCalls: new UiCallCollector(),
    tender: null,
    tenderCache: new Map(),
    onboardingRole: "admin",
    matchEnabled: true,
    clientContext: {},
    milestoneContext: { tenantId, companyId: new ObjectId(), userId: "u1" },
  };
}

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ["GEMINI_API_KEY", "AI_AGENT_MAX_ITERATIONS"];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.GEMINI_API_KEY = "test";
  complete.clear();
  resetAiEnvCache();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetAiEnvCache();
  setAgentModelForTests(null);
});

/** Drive one turn and report what the user would actually have seen. */
async function turn(
  graph: Awaited<ReturnType<typeof buildOttoGraph>>,
  threadId: string,
  text: string,
) {
  const state = await graph.invoke(
    { messages: [new HumanMessage(text)] },
    { configurable: { thread_id: threadId } },
  );
  const last = state.messages[state.messages.length - 1];
  return { state, replyText: String(last?.content ?? "") };
}

describe("Otto graph", () => {
  it("asks a profile question with real prose, never an empty message", async () => {
    setAgentModelForTests(
      new FakeToolCallingChatModel([new AIMessage("Welcome! What is your role?")]),
    );
    const graph = await buildOttoGraph(fakeCtx());

    const { state, replyText } = await turn(graph, "t-profile", "hi");

    // Bug 3: this used to come back as "".
    expect(replyText).toBe("Welcome! What is your role?");
    expect(state.pendingQuestion).toBe("role");
    expect(state.status).toBe("profiling");
  });

  it("records each answer and moves to the next question", async () => {
    setAgentModelForTests(
      new FakeToolCallingChatModel([
        new AIMessage("What is your role?"),
        new AIMessage("What do you want to do first?"),
      ]),
    );
    const graph = await buildOttoGraph(fakeCtx());

    await turn(graph, "t-answers", "hi");
    const { state } = await turn(graph, "t-answers", "owner");

    expect(state.userProfile).toEqual({ role: "owner" });
    expect(state.pendingQuestion).toBe("goal");
  });

  it("resets the iteration cap every turn so tools stay reachable", async () => {
    process.env.AI_AGENT_MAX_ITERATIONS = "2";
    resetAiEnvCache();

    // Three profile questions, then guide turns that each call a tool.
    setAgentModelForTests(
      new FakeToolCallingChatModel([
        new AIMessage("q1"),
        new AIMessage("q2"),
        new AIMessage("q3"),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c1", name: "start_milestone_tour", args: {} }],
        }),
        new AIMessage("Here is your first step."),
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c2", name: "start_milestone_tour", args: {} }],
        }),
        new AIMessage("And the next one."),
      ]),
    );
    const graph = await buildOttoGraph(fakeCtx());

    await turn(graph, "t-cap", "hi");
    await turn(graph, "t-cap", "owner");
    await turn(graph, "t-cap", "findTenders");
    const first = await turn(graph, "t-cap", "solo");
    const second = await turn(graph, "t-cap", "what next?");

    // Bug 1: iterations used to accumulate across turns, so by here the cap
    // was permanently exceeded and the tool branch was unreachable.
    expect(first.state.iterations).toBeLessThanOrEqual(2);
    expect(second.state.iterations).toBeLessThanOrEqual(2);
    expect(second.replyText).toBe("And the next one.");
  });

  it("plans only milestones that are not already complete", async () => {
    complete.add("complete_company_profile");
    complete.add("build_ai_matches");

    setAgentModelForTests(
      new FakeToolCallingChatModel([
        new AIMessage("q1"),
        new AIMessage("q2"),
        new AIMessage("q3"),
        new AIMessage("Let's start here."),
      ]),
    );
    const graph = await buildOttoGraph(fakeCtx());

    await turn(graph, "t-plan", "hi");
    await turn(graph, "t-plan", "owner");
    await turn(graph, "t-plan", "findTenders");
    const { state } = await turn(graph, "t-plan", "solo");

    expect(state.plannedMilestones).not.toContain("complete_company_profile");
    expect(state.plannedMilestones).not.toContain("build_ai_matches");
    expect(state.plannedMilestones.length).toBeGreaterThan(0);
    expect(state.currentMilestoneId).toBe(state.plannedMilestones[0]);
    expect(state.status).toBe("guiding");
  });

  it("reports completed when every milestone is already done", async () => {
    for (const id of [
      "complete_company_profile",
      "build_ai_matches",
      "save_first_tender",
      "review_pipeline",
      "upload_first_document",
      "ask_clara",
      "generate_first_report",
    ] as MilestoneId[]) {
      complete.add(id);
    }

    setAgentModelForTests(
      new FakeToolCallingChatModel([
        new AIMessage("q1"),
        new AIMessage("q2"),
        new AIMessage("q3"),
        new AIMessage("You're all set."),
      ]),
    );
    const graph = await buildOttoGraph(fakeCtx());

    await turn(graph, "t-done", "hi");
    await turn(graph, "t-done", "owner");
    await turn(graph, "t-done", "findTenders");
    const { state, replyText } = await turn(graph, "t-done", "solo");

    expect(state.status).toBe("completed");
    expect(state.plannedMilestones).toEqual([]);
    // Still says something — an empty plan is not an excuse for silence.
    expect(replyText).toBe("You're all set.");
  });

  it("does not advance a milestone the data says is unfinished", async () => {
    setAgentModelForTests(
      new FakeToolCallingChatModel([
        new AIMessage("q1"),
        new AIMessage("q2"),
        new AIMessage("q3"),
        new AIMessage("Start here."),
        new AIMessage("Done yet?"),
      ]),
    );
    const graph = await buildOttoGraph(fakeCtx());

    await turn(graph, "t-verify", "hi");
    await turn(graph, "t-verify", "owner");
    await turn(graph, "t-verify", "findTenders");
    const planned = await turn(graph, "t-verify", "solo");
    const current = planned.state.currentMilestoneId;

    // The model claiming success changes nothing; only `isMilestoneComplete` does.
    const after = await turn(graph, "t-verify", "I did it, promise");

    expect(after.state.currentMilestoneId).toBe(current);
    expect(after.state.completedMilestoneIds).not.toContain(current);
    expect(after.state.attemptCount).toBeGreaterThan(0);
  });
});
