import { SystemMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { aiEnv } from "../config/env.ts";
import { getAgentChatModel } from "./model.ts";
import { buildDoraSystemPrompt } from "./prompt.ts";
import { buildDoraTools } from "./tools.ts";
import type { AgentRunContext } from "./context.ts";
import { getDoraCheckpointer } from "./checkpointer.ts";

/**
 * Dora's chat graph: a minimal, capped tool loop.
 *
 *   trim → model(tools bound) ─ has tool_calls & under cap ─► tools → model
 *                             ─ has tool_calls & cap hit ───► finalize → END
 *                             ─ no tool_calls ──────────────► END
 *
 * Hand-rolled (not createReactAgent) for three reasons: an explicit iteration
 * cap with a forced-finalize path (model re-invoked with NO tools bound, so
 * it must answer), a per-turn fresh system prompt (never persisted — prompt
 * upgrades apply to old threads), and no dependency on the prebuilt's prompt
 * API. ToolNode is reused so tool errors become ToolMessages, not crashes.
 */

const DoraState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  iterations: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
});

export type DoraStateType = typeof DoraState.State;

function lastMessage(state: DoraStateType): BaseMessage | undefined {
  return state.messages[state.messages.length - 1];
}

function hasToolCalls(message: BaseMessage | undefined): boolean {
  // Duck-typed on purpose: under streamEvents the model yields AIMessageChunk,
  // which is NOT instanceof AIMessage — an instanceof check silently ends the
  // loop before any tool ever runs.
  if (!message || message.getType() !== "ai") return false;
  const calls = (message as { tool_calls?: unknown[] }).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}

export async function buildDoraGraph(ctx: AgentRunContext) {
  const env = aiEnv();
  const model = await getAgentChatModel();
  const tools = buildDoraTools(ctx);
  const boundModel = model.bindTools ? model.bindTools(tools) : model;
  const systemPrompt = new SystemMessage(buildDoraSystemPrompt(ctx));

  const trimNode = (state: DoraStateType) => {
    const max = env.agentHistoryMaxMessages;
    if (state.messages.length <= max) return { iterations: 0 };
    // Replace-style update is not available with a concat reducer, so the
    // graph keeps full state; trimming happens at model-call time below.
    return { iterations: 0 };
  };

  const contextWindow = (messages: BaseMessage[]): BaseMessage[] => {
    const max = env.agentHistoryMaxMessages;
    const window = messages.length > max ? messages.slice(-max) : messages;
    // Never start the window on a ToolMessage (orphaned tool result confuses
    // providers): drop leading tool messages.
    let start = 0;
    while (start < window.length && window[start].getType() === "tool") start += 1;
    return window.slice(start);
  };

  // Forwarding `config` into every model invocation is what propagates the
  // callback manager — without it, streamEvents sees no token/tool events.
  const modelNode = async (state: DoraStateType, config: RunnableConfig) => {
    const response = await boundModel.invoke(
      [systemPrompt, ...contextWindow(state.messages)],
      config,
    );
    return { messages: [response], iterations: state.iterations + 1 };
  };

  const finalizeNode = async (state: DoraStateType, config: RunnableConfig) => {
    // Cap reached with the model still asking for tools: strip the dangling
    // tool-call request and force a plain answer with no tools bound.
    const messages = hasToolCalls(lastMessage(state))
      ? state.messages.slice(0, -1)
      : state.messages;
    const response = await model.invoke(
      [systemPrompt, ...contextWindow(messages)],
      config,
    );
    return { messages: [response] };
  };

  const graph = new StateGraph(DoraState)
    .addNode("trim", trimNode)
    .addNode("model", modelNode)
    .addNode("tools", new ToolNode(tools))
    .addNode("finalize", finalizeNode)
    .addEdge(START, "trim")
    .addEdge("trim", "model")
    .addConditionalEdges("model", (state) => {
      if (!hasToolCalls(lastMessage(state))) return END;
      return state.iterations >= env.agentMaxIterations ? "finalize" : "tools";
    })
    .addEdge("tools", "model")
    .addEdge("finalize", END);

  const checkpointer = await getDoraCheckpointer();
  return graph.compile({ checkpointer });
}
