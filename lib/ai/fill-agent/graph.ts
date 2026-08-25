import { SystemMessage } from "@langchain/core/messages";

import { aiEnv } from "../config/env.ts";
import { getClaraCheckpointer } from "../agent/checkpointer.ts";
import { getChatModel } from "../agent/model.ts";
import type { CompiledAgentGraph } from "../agent/service.ts";
import { buildToolLoopGraph, toolLoopRecursionLimit } from "../agent/tool-loop.ts";
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
 * This agent legitimately chains fill→repair→fill inside a single turn, so it
 * needs a wider superstep budget than the shared default in runChatTurn. The
 * limit is passed per turn rather than wrapped around the graph — that wrapper
 * was always meant to be temporary (docs/agentic-ai/06-review §6.1) and
 * runChatTurn now sets a limit for every agent.
 */
export function fillAgentRecursionLimit(maxIterations: number): number {
  return toolLoopRecursionLimit(maxIterations);
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
    historyMaxTokens: env.agentHistoryMaxTokens,
    checkpointer: await getClaraCheckpointer(),
  });
  return graph;
}
