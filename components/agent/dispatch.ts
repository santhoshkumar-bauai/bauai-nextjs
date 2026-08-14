import type { z } from "zod";

import type { WireUiCall } from "@/lib/ai/agent/wire";

/**
 * The validation gate every agent-requested UI action passes through, kept
 * pure and React-free so it can be tested directly.
 *
 * The agent names an action and hands over opaque args. Three things can be
 * wrong with that — the action may not exist on this page, the args may not
 * match its schema, or the handler may throw — and all three must degrade to
 * a reported no-op. A guided tour that silently does the wrong thing is worse
 * than one that stops and tells you it drifted.
 */

export type AgentActionFailure =
  | { reason: "unknown_action"; action: string }
  | { reason: "invalid_args"; action: string; detail: string }
  | { reason: "handler_threw"; action: string; detail: string };

export interface RegisteredAction {
  schema: z.ZodType;
  /**
   * Stored erased. Only ever called with a value `schema` just produced, so
   * the cast at registration cannot widen what a handler actually receives.
   */
  run: (args: unknown) => void | Promise<void>;
}

export interface DispatchUiCallsInput {
  calls: WireUiCall[];
  /** Actions registered by currently mounted components. */
  resolve: (action: string) => RegisteredAction | undefined;
  /**
   * Ids already run this session. Mutated as calls execute so a checkpoint
   * replay cannot navigate or seed twice — ids are sequence-based server-side
   * precisely so this de-duplication works across a resume.
   */
  executed: Set<string>;
  onFailure?: (failure: AgentActionFailure) => void;
}

export async function dispatchUiCalls({
  calls,
  resolve,
  executed,
  onFailure,
}: DispatchUiCallsInput): Promise<void> {
  for (const call of calls) {
    if (executed.has(call.id)) continue;
    executed.add(call.id);

    const action = resolve(call.action);
    if (!action) {
      onFailure?.({ reason: "unknown_action", action: call.action });
      continue;
    }

    const parsed = action.schema.safeParse(call.args);
    if (!parsed.success) {
      onFailure?.({
        reason: "invalid_args",
        action: call.action,
        detail: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; "),
      });
      continue;
    }

    try {
      await action.run(parsed.data);
    } catch (error) {
      onFailure?.({
        reason: "handler_threw",
        action: call.action,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
