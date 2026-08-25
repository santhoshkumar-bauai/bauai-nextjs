import { SystemMessage } from "@langchain/core/messages";

import { aiEnv } from "../config/env.ts";
import { getClaraCheckpointer } from "../agent/checkpointer.ts";
import { getChatModel } from "../agent/model.ts";
import type { CompiledAgentGraph } from "../agent/service.ts";
import { buildToolLoopGraph } from "../agent/tool-loop.ts";
import type { FillAgentRunContext } from "./context.ts";
import { fillAgentEnv } from "./env.ts";
import { buildFillAgentSystemPrompt } from "./prompts.ts";
import { buildFillAgentTools } from "./tools.ts";

/**
 * The fill agent's chat graph: the shared capped tool loop with the pinned
 * fill_agent role, the fill tools and the orchestration prompt. Checkpointer
 * shared with Clara/Dora; the `fillagent:` thread-key namespace keeps state
 * disjoint.
 *
 * The streamEvents wrapper exists for ONE reason (docs/agentic-ai/06-review
 * §6.1): runChatTurn sets no recursionLimit, LangGraph defaults to 25, and
 * this agent legitimately chains fill→repair→fill inside a turn. Worst case
 * the loop takes 2 supersteps per iteration (+begin/finalize), so the default
 * would throw GraphRecursionError mid-repair and surface as a bare "failed".
 * Promotion step: move the limit into service.ts and drop this wrapper.
 */
export function fillAgentRecursionLimit(maxIterations: number): number {
  return 2 * maxIterations + 4;
}

/** Wrap a compiled graph so every streamEvents call carries the limit —
 * ours must win even if a caller ever starts passing one. */
export function withRecursionLimit(
  graph: CompiledAgentGraph,
  recursionLimit: number,
): CompiledAgentGraph {
  return {
    streamEvents: (input, options) =>
      graph.streamEvents(input, { ...options, recursionLimit }),
  };
}

export async function buildFillAgentGraph(
  ctx: FillAgentRunContext,
): Promise<CompiledAgentGraph> {
  const env = aiEnv();
  const fillEnv = fillAgentEnv();
  const graph = buildToolLoopGraph({
    model: await getChatModel({ role: "fill_agent" }),
    tools: buildFillAgentTools(ctx),
    systemPrompt: new SystemMessage(buildFillAgentSystemPrompt(ctx)),
    maxIterations: fillEnv.maxIterations,
    historyMaxMessages: env.agentHistoryMaxMessages,
    checkpointer: await getClaraCheckpointer(),
  });
  return withRecursionLimit(graph, fillAgentRecursionLimit(fillEnv.maxIterations));
}
