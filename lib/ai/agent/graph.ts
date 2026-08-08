import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { aiEnv } from "../config/env.ts";
import { resolveMediaParts } from "./attachments.ts";
import { textFromContent } from "./content.ts";
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

/**
 * Drop broken tool-call/response pairings before a model call. The finalize
 * path leaves the model's DANGLING tool-call request in checkpointed state
 * (a concat reducer can only append), and Gemini hard-rejects any history
 * where a function-call turn is not immediately followed by its function
 * responses ("Please ensure that function call turn comes immediately
 * after…"). Sanitizing at read time also heals threads poisoned before this
 * fix existed. Exported for tests.
 */
export function sanitizeToolPairs(messages: BaseMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.getType() === "tool") {
      // Keep only tool responses that directly follow their calling AI
      // message (skipping earlier kept tool siblings of the same call).
      let j = out.length - 1;
      while (j >= 0 && out[j].getType() === "tool") j -= 1;
      if (j >= 0 && hasToolCalls(out[j])) out.push(message);
      continue;
    }
    if (hasToolCalls(message)) {
      // Keep only tool-call messages whose responses actually follow.
      if (messages[i + 1]?.getType() === "tool") out.push(message);
      continue;
    }
    out.push(message);
  }
  return out;
}

export async function buildDoraGraph(ctx: AgentRunContext) {
  const env = aiEnv();
  // Global chats chain find_tenders → notice → search and need more hops.
  const maxIterations = ctx.tender
    ? env.agentMaxIterations
    : env.agentGlobalMaxIterations;
  const model = await getAgentChatModel();
  const tools = buildDoraTools(ctx);
  const boundModel = model.bindTools ? model.bindTools(tools) : model;
  const systemPrompt = new SystemMessage(buildDoraSystemPrompt(ctx));

  // Resetting the iteration counter is this node's entire job — it re-arms
  // the tool-loop cap at the start of every turn. History trimming happens
  // at model-call time in contextWindow() (a concat reducer can't shrink).
  const beginTurnNode = () => ({ iterations: 0 });

  const contextWindow = (messages: BaseMessage[]): BaseMessage[] => {
    const max = env.agentHistoryMaxMessages;
    const window = messages.length > max ? messages.slice(-max) : messages;
    // Repairs both slice damage (window starting on orphaned tool results)
    // and dangling tool-call turns left in state by the finalize path.
    return sanitizeToolPairs(window);
  };

  // Attached images are checkpointed as tiny media_ref parts; the base64
  // payload is materialized here, per model call, cached for the turn.
  const mediaCache = new Map<string, string>();

  // Forwarding `config` into every model invocation is what propagates the
  // callback manager — without it, streamEvents sees no token/tool events.
  const modelNode = async (state: DoraStateType, config: RunnableConfig) => {
    const window = await resolveMediaParts(contextWindow(state.messages), mediaCache);
    const response = await boundModel.invoke([systemPrompt, ...window], config);
    return { messages: [response], iterations: state.iterations + 1 };
  };

  const finalizeNode = async (state: DoraStateType, config: RunnableConfig) => {
    // Cap reached with the model still asking for tools (or an empty
    // answer): strip the dangling tool-call request and force plain prose
    // with no tools bound. The explicit nudge matters — a history full of
    // function-call/response pairs makes Gemini pattern-continue with MORE
    // functionCall parts even when no tools are declared; without it the
    // turn ends with zero user-visible text.
    const messages = hasToolCalls(lastMessage(state))
      ? state.messages.slice(0, -1)
      : state.messages;
    const window = await resolveMediaParts(contextWindow(messages), mediaCache);
    const nudge = new HumanMessage(
      "Stop gathering. Using ONLY the information collected above, give your final answer to my original question now, in plain prose. If something could not be determined, say so explicitly. Do not request any tools.",
    );
    let response = await model.invoke([systemPrompt, ...window, nudge], config);
    if (!textFromContent(response.content).trim()) {
      // One retry — Gemini occasionally needs a second pass to break the
      // function-call pattern.
      response = await model.invoke([systemPrompt, ...window, nudge], config);
    }
    return { messages: [response] };
  };

  const graph = new StateGraph(DoraState)
    .addNode("beginTurn", beginTurnNode)
    .addNode("model", modelNode)
    .addNode("tools", new ToolNode(tools))
    .addNode("finalize", finalizeNode)
    .addEdge(START, "beginTurn")
    .addEdge("beginTurn", "model")
    .addConditionalEdges("model", (state) => {
      const last = lastMessage(state);
      if (!hasToolCalls(last)) {
        // A thinking model can exhaust its output budget on reasoning and
        // "answer" with zero text. Route through finalize (no tools bound,
        // must produce prose) instead of ending on an empty reply.
        return textFromContent(last?.content).trim() ? END : "finalize";
      }
      return state.iterations >= maxIterations ? "finalize" : "tools";
    })
    .addEdge("tools", "model")
    .addEdge("finalize", END);

  const checkpointer = await getDoraCheckpointer();
  return graph.compile({ checkpointer });
}
