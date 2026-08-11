import { SystemMessage } from "@langchain/core/messages";

import { aiEnv } from "../config/env.ts";
import { getClaraCheckpointer } from "../agent/checkpointer.ts";
import { getChatModel } from "../agent/model.ts";
import { buildToolLoopGraph } from "../agent/tool-loop.ts";
import type { DoraRunContext } from "./context.ts";
import { buildDoraSystemPrompt } from "./prompt.ts";
import { buildDoraTools } from "./tools.ts";

/**
 * Dora's chat graph: the shared capped tool loop (tool-loop.ts — including
 * all its Gemini history hygiene) with Dora's model role, tools and prompt.
 * Checkpointer and collections are shared with Clara; the `dora:` thread-key
 * namespace keeps the states disjoint.
 */
export async function buildDoraGraph(ctx: DoraRunContext) {
  const env = aiEnv();
  return buildToolLoopGraph({
    model: await getChatModel({ role: "dora" }),
    tools: buildDoraTools(ctx),
    systemPrompt: new SystemMessage(buildDoraSystemPrompt(ctx)),
    maxIterations: env.agentMaxIterations,
    historyMaxMessages: env.agentHistoryMaxMessages,
    checkpointer: await getClaraCheckpointer(),
  });
}
