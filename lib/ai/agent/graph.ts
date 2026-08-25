import { SystemMessage } from "@langchain/core/messages";

import { aiEnv } from "../config/env.ts";
import { getAgentChatModel } from "./model.ts";
import { buildClaraSystemPrompt } from "./prompt.ts";
import { buildClaraTools } from "./tools.ts";
import type { AgentRunContext } from "./context.ts";
import { getClaraCheckpointer } from "./checkpointer.ts";
import { buildToolLoopGraph } from "./tool-loop.ts";

// The loop shape and its Gemini history hygiene live in tool-loop.ts (shared
// with Dora). Re-exported here because the unit tests and older call sites
// import them from the graph module.
export { sanitizeToolPairs, windowFromUserTurn } from "./tool-loop.ts";
export type { ToolLoopStateType as ClaraStateType } from "./tool-loop.ts";

/** Clara's chat graph: the shared capped tool loop with Clara's model/tools/prompt. */
export async function buildClaraGraph(ctx: AgentRunContext) {
  const env = aiEnv();
  // Global chats chain find_tenders → notice → search and need more hops.
  const maxIterations = ctx.tender
    ? env.agentMaxIterations
    : env.agentGlobalMaxIterations;
  return buildToolLoopGraph({
    model: await getAgentChatModel(),
    tools: buildClaraTools(ctx),
    systemPrompt: new SystemMessage(buildClaraSystemPrompt(ctx)),
    maxIterations,
    historyMaxMessages: env.agentHistoryMaxMessages,
    historyMaxTokens: env.agentHistoryMaxTokens,
    checkpointer: await getClaraCheckpointer(),
  });
}
