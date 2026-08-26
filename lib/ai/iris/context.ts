import type { CompanyContext } from "../../company/context.ts";
import {
  buildGlobalAgentRunContext,
  type AgentRunContext,
} from "../agent/context.ts";
import { BlockEmitter } from "./emitter.ts";

/**
 * Iris's run context: Clara's global (company-scoped, tender-free) context plus
 * the block emitter.
 *
 * Reusing `AgentRunContext` rather than defining a parallel shape is the whole
 * reason this POC can render REAL data on day one — `listRelevantTenders`,
 * `listWorkspaceTenders`, `getTenderCoverage` and the retrieval helpers are all
 * typed against it, and they carry the tenant-scoping invariant with them:
 * tenancy comes from the authenticated request, never from a tool input, so a
 * prompt-injected tool call cannot render another company's board.
 */
export interface IrisRunContext extends AgentRunContext {
  blocks: BlockEmitter;
}

export function buildIrisRunContext(input: {
  companyContext: CompanyContext;
  locale: "en" | "de";
}): IrisRunContext {
  return {
    ...buildGlobalAgentRunContext(input),
    blocks: new BlockEmitter(),
  };
}
