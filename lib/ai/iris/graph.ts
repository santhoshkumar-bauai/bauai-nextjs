import { SystemMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import { getChatModel } from "../agent/model.ts";
import {
  createToolLoopNodes,
  toolLoopRecursionLimit,
  toolLoopStateSpec,
} from "../agent/tool-loop.ts";
import { aiEnv } from "../config/env.ts";
import type { IrisRunContext } from "./context.ts";
import { buildIrisSystemPrompt } from "./prompt.ts";
import { buildIrisTools } from "./tools.ts";

/**
 * Iris's graph: the same capped tool loop Clara and Dora run, with three
 * deliberate differences.
 *
 * NO CHECKPOINTER. Every other agent here persists its thread server-side and
 * replays it from Mongo. Iris's history lives in the AI SDK's `UIMessage[]`,
 * which the client posts in full on every turn — that is how `useChat` works,
 * and it is the right trade for a surface whose state includes RENDERED
 * BLOCKS, not just text. Adding a checkpointer would give two sources of truth
 * for one conversation and guarantee they drift.
 *
 * A LOWER ITERATION CAP. Clara chains find → notice → search across eight
 * hops. A view either has data behind it or it does not, and `show_tender_
 * spotlight` reports which — so a turn that needs six tool calls is a turn
 * that has lost the plot, and the user has been staring at skeletons the whole
 * time.
 */

export const IRIS_MAX_ITERATIONS = 6;

/** Superstep budget for the loop above; see `toolLoopRecursionLimit`. */
export const IRIS_RECURSION_LIMIT = toolLoopRecursionLimit(IRIS_MAX_ITERATIONS);

const IrisState = Annotation.Root(toolLoopStateSpec);

export type IrisStateType = typeof IrisState.State;

export async function buildIrisGraph(ctx: IrisRunContext) {
  const env = aiEnv();
  const nodes = createToolLoopNodes({
    model: await getChatModel({ role: "iris" }),
    tools: buildIrisTools(ctx),
    // Rebuilt per turn, never checkpointed: the catalog rules and the company
    // profile in it must apply to conversations already in flight.
    systemPrompt: new SystemMessage(buildIrisSystemPrompt(ctx)),
    maxIterations: IRIS_MAX_ITERATIONS,
    historyMaxMessages: env.agentHistoryMaxMessages,
    historyMaxTokens: env.agentHistoryMaxTokens,
  });

  return new StateGraph(IrisState)
    .addNode("beginTurn", nodes.beginTurn)
    .addNode("model", nodes.model)
    .addNode("tools", nodes.tools)
    .addNode("finalize", nodes.finalize)
    .addEdge(START, "beginTurn")
    .addEdge("beginTurn", "model")
    .addConditionalEdges("model", (state: IrisStateType) => {
      const route = nodes.routeAfterModel(state);
      return route === "done" ? END : route;
    })
    .addEdge("tools", "model")
    .addEdge("finalize", END)
    .compile();
}
