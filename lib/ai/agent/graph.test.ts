import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetAiEnvCache } from "../config/env.ts";
import { CitationCollector } from "./citations.ts";
import type { AgentRunContext } from "./context.ts";
import { FakeToolCallingChatModel } from "./testing.ts";
import { setAgentModelForTests } from "./model.ts";

// The graph pulls tools + checkpointer; both are mocked for unit isolation.
vi.mock("./tools.ts", () => ({
  buildClaraTools: () => [
    {
      name: "get_tender_notice",
      description: "test tool",
      schema: undefined,
      invoke: async () => JSON.stringify({ title: "Test" }),
    },
  ],
}));
vi.mock("./checkpointer.ts", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getClaraCheckpointer: async () => saver };
});
// ToolNode needs real StructuredTools; simplest is to mock the whole prebuilt
// ToolNode call with a passthrough node producing a ToolMessage.
vi.mock("@langchain/langgraph/prebuilt", async () => {
  const { ToolMessage } = await import("@langchain/core/messages");
  class FakeToolNode {
    async invoke(state: { messages: Array<{ tool_calls?: Array<{ id?: string; name: string }> }> }) {
      const last = state.messages[state.messages.length - 1];
      const calls = last.tool_calls ?? [];
      return {
        messages: calls.map(
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

const { buildClaraGraph, sanitizeToolPairs } = await import("./graph.ts");

function fakeCtx(): AgentRunContext {
  return {
    tenantId: new ObjectId(),
    userId: "u",
    locale: "en",
    companyContext: {} as never,
    citations: new CitationCollector(),
    tender: {
      tenderId: new ObjectId(),
      tenderDetail: {
        title: "T",
        status: "OPEN",
        buyer: null,
        submissionDeadline: null,
      } as never,
    },
    tenderCache: new Map(),
  };
}

const ENV_KEYS = ["AI_AGENT_MAX_ITERATIONS", "GEMINI_API_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  process.env.GEMINI_API_KEY = "test";
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

function toolCallMessage(): AIMessage {
  return new AIMessage({
    content: "",
    tool_calls: [{ id: "call-1", name: "get_tender_notice", args: {} }],
  });
}

describe("sanitizeToolPairs", () => {
  const toolMsg = (id: string) =>
    new ToolMessage({ content: "result", tool_call_id: id, name: "t" });

  it("drops a dangling tool-call turn (the finalize leftover Gemini 400s on)", () => {
    const messages = [
      new HumanMessage("q"),
      toolCallMessage(), // dangling: next message is NOT a tool response
      new AIMessage("final answer"),
    ];
    const cleaned = sanitizeToolPairs(messages);
    expect(cleaned.map((m) => m.getType())).toEqual(["human", "ai"]);
    expect(String(cleaned[1].content)).toBe("final answer");
  });

  it("keeps complete pairs including parallel tool responses", () => {
    const messages = [
      new HumanMessage("q"),
      toolCallMessage(),
      toolMsg("call-1"),
      toolMsg("call-2"),
      new AIMessage("answer"),
    ];
    expect(sanitizeToolPairs(messages)).toHaveLength(5);
  });

  it("drops orphaned leading tool responses (window-slice damage)", () => {
    const messages = [toolMsg("old"), new HumanMessage("q"), new AIMessage("a")];
    expect(sanitizeToolPairs(messages).map((m) => m.getType())).toEqual([
      "human",
      "ai",
    ]);
  });
});

describe("buildClaraGraph", () => {
  it("runs one tool round then answers", async () => {
    const fake = new FakeToolCallingChatModel([
      toolCallMessage(),
      new AIMessage("The deadline is next month."),
    ]);
    setAgentModelForTests(fake);

    const graph = await buildClaraGraph(fakeCtx());
    const result = await graph.invoke(
      { messages: [new HumanMessage("When is the deadline?")] },
      { configurable: { thread_id: `test-${Date.now()}` } },
    );

    const last = result.messages[result.messages.length - 1];
    expect(String(last.content)).toContain("deadline is next month");
    // 2 model calls, both through the tools-bound view.
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.every((call) => call.withTools)).toBe(true);
  });

  it("forces finalize WITHOUT tools when the iteration cap is hit", async () => {
    process.env.AI_AGENT_MAX_ITERATIONS = "2";
    resetAiEnvCache();

    // Two tool-call turns exhaust the cap of 2; the third model invocation IS
    // the finalize pass (unbound model) and must produce the answer.
    const fake = new FakeToolCallingChatModel([
      toolCallMessage(),
      toolCallMessage(),
      new AIMessage("Best answer with what I have."),
    ]);
    setAgentModelForTests(fake);

    const graph = await buildClaraGraph(fakeCtx());
    const result = await graph.invoke(
      { messages: [new HumanMessage("Hard question")] },
      { configurable: { thread_id: `test-cap-${Date.now()}` } },
    );

    const last = result.messages[result.messages.length - 1];
    expect(String(last.content)).toContain("Best answer");
    // Final call must have gone through the UNBOUND base model.
    const lastCall = fake.calls[fake.calls.length - 1];
    expect(lastCall.withTools).toBe(false);
  });

  it("recovers via finalize when the model answers with empty text", async () => {
    // A thinking model that burned its budget on reasoning: no tool calls,
    // no text. The graph must retry through finalize instead of ending empty.
    const fake = new FakeToolCallingChatModel([
      new AIMessage(""),
      new AIMessage("Recovered answer."),
    ]);
    setAgentModelForTests(fake);

    const graph = await buildClaraGraph(fakeCtx());
    const result = await graph.invoke(
      { messages: [new HumanMessage("Question")] },
      { configurable: { thread_id: `test-empty-${Date.now()}` } },
    );

    const last = result.messages[result.messages.length - 1];
    expect(String(last.content)).toContain("Recovered answer");
    const lastCall = fake.calls[fake.calls.length - 1];
    expect(lastCall.withTools).toBe(false);
  });

  it("keeps checkpointed context across turns on the same thread", async () => {
    const threadId = `test-memory-${Date.now()}`;
    const fake = new FakeToolCallingChatModel([
      new AIMessage("Noted: your budget is 2M EUR."),
      new AIMessage("You told me 2M EUR."),
    ]);
    setAgentModelForTests(fake);

    const ctx = fakeCtx();
    const graph = await buildClaraGraph(ctx);
    await graph.invoke(
      { messages: [new HumanMessage("Our budget is 2M EUR.")] },
      { configurable: { thread_id: threadId } },
    );
    await graph.invoke(
      { messages: [new HumanMessage("What did I tell you?")] },
      { configurable: { thread_id: threadId } },
    );

    // Second call must have seen the first exchange (3+ messages in context).
    expect(fake.calls[1].messageCount).toBeGreaterThanOrEqual(4);
  });
});
