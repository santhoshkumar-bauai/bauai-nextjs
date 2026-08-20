import { SystemMessage } from "@langchain/core/messages";

import type { StoredSpreadsheetContext } from "@/lib/dora-gateway/spreadsheet-schema";

import { getClaraCheckpointer } from "../../agent/checkpointer";
import { getChatModel } from "../../agent/model";
import { buildToolLoopGraph } from "../../agent/tool-loop";
import { aiEnv } from "../../config/env";
import type { DoraRunContext } from "../context";
import { buildDoraSpreadsheetSystemPrompt } from "./prompt";
import { buildDoraSpreadsheetTools } from "./tools";

export async function buildDoraSpreadsheetGraph(
  ctx: DoraRunContext,
  context: StoredSpreadsheetContext | null,
) {
  const env = aiEnv();
  return buildToolLoopGraph({
    model: await getChatModel({ role: "dora" }),
    tools: buildDoraSpreadsheetTools(ctx),
    systemPrompt: new SystemMessage(buildDoraSpreadsheetSystemPrompt(ctx, context)),
    maxIterations: env.agentMaxIterations,
    historyMaxMessages: env.agentHistoryMaxMessages,
    checkpointer: await getClaraCheckpointer(),
  });
}
