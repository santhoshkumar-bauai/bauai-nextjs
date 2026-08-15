"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import type { z } from "zod";

import type { WireUiCall } from "@/lib/ai/agent/wire";
import {
  dispatchUiCalls,
  type AgentActionFailure,
  type RegisteredAction,
} from "./dispatch";

/**
 * The client half of agent-driven UI: a registry of actions the agent may
 * invoke, and of readable context it may consult. The validation gate itself
 * lives in ./dispatch.ts, kept pure so it can be tested without React.
 *
 * Deliberately a ref-backed context rather than a store: registration happens
 * in the effects of many components and must not re-render every consumer,
 * and this repo has no state library to borrow.
 */

export type { AgentActionFailure };

interface AgentActionsContextValue {
  registerAction: (name: string, action: RegisteredAction) => () => void;
  registerReadable: (key: string, read: () => unknown) => () => void;
  dispatch: (calls: WireUiCall[]) => Promise<void>;
  snapshotReadables: () => Record<string, unknown>;
}

const AgentActionsContext = createContext<AgentActionsContextValue | null>(null);

export function AgentActionsProvider({
  children,
  onFailure,
}: {
  children: ReactNode;
  /** Reported for every dropped call; wired to telemetry by the caller. */
  onFailure?: (failure: AgentActionFailure) => void;
}) {
  const actions = useRef(new Map<string, RegisteredAction>());
  const readables = useRef(new Map<string, () => unknown>());
  const executed = useRef(new Set<string>());
  // Latest-ref pattern: dispatch is a stable callback but must report to the
  // CURRENT handler, and refs may only be written in an effect.
  const failureRef = useRef(onFailure);
  useEffect(() => {
    failureRef.current = onFailure;
  }, [onFailure]);

  const registerAction = useCallback((name: string, action: RegisteredAction) => {
    actions.current.set(name, action);
    return () => {
      // Guard the delete: a remount can register the replacement before the
      // outgoing effect cleans up, and an unguarded delete would unregister
      // the live handler.
      if (actions.current.get(name) === action) actions.current.delete(name);
    };
  }, []);

  const registerReadable = useCallback((key: string, read: () => unknown) => {
    readables.current.set(key, read);
    return () => {
      if (readables.current.get(key) === read) readables.current.delete(key);
    };
  }, []);

  const snapshotReadables = useCallback((): Record<string, unknown> => {
    const snapshot: Record<string, unknown> = {};
    for (const [key, read] of readables.current) {
      try {
        snapshot[key] = read();
      } catch {
        // A readable that throws is worth less than the turn it would break.
        snapshot[key] = null;
      }
    }
    return snapshot;
  }, []);

  const dispatch = useCallback(
    (calls: WireUiCall[]) =>
      dispatchUiCalls({
        calls,
        resolve: (name) => actions.current.get(name),
        executed: executed.current,
        onFailure: (failure) => failureRef.current?.(failure),
      }),
    [],
  );

  const value = useMemo(
    () => ({ registerAction, registerReadable, dispatch, snapshotReadables }),
    [registerAction, registerReadable, dispatch, snapshotReadables],
  );

  return (
    <AgentActionsContext.Provider value={value}>
      {children}
    </AgentActionsContext.Provider>
  );
}

function useAgentActionsContext(hook: string): AgentActionsContextValue {
  const context = useContext(AgentActionsContext);
  if (!context) {
    throw new Error(`${hook} must be used inside <AgentActionsProvider>`);
  }
  return context;
}

/**
 * Register one action the agent may invoke. `handler` is typed from `schema`,
 * so a parameter the schema does not describe is a compile error rather than
 * an `unknown` to cast away at the call site.
 */
export function useAgentAction<Schema extends z.ZodType>(input: {
  name: string;
  schema: Schema;
  handler: (args: z.infer<Schema>) => void | Promise<void>;
}): void {
  const { registerAction } = useAgentActionsContext("useAgentAction");

  // Held in a ref so a handler closing over fresh props does not churn the
  // registry on every render.
  const handlerRef = useRef(input.handler);
  useEffect(() => {
    handlerRef.current = input.handler;
  }, [input.handler]);

  // `schema` IS a dependency: schemas are module constants in practice, so
  // this does not churn — but if one ever changes identity, re-registering is
  // the correct response, not validating against a stale copy.
  const { name, schema } = input;
  useEffect(
    () =>
      registerAction(name, {
        schema,
        run: (args) => handlerRef.current(args as z.infer<Schema>),
      }),
    [name, schema, registerAction],
  );
}

/**
 * Publish a slice of client state the agent can read — current route, whether
 * a target is on screen, the user's profile. Sent with each turn so the agent
 * never has to guess where the user is.
 */
export function useAgentReadable(key: string, value: unknown): void {
  const { registerReadable } = useAgentActionsContext("useAgentReadable");

  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(
    () => registerReadable(key, () => valueRef.current),
    [key, registerReadable],
  );
}

/** Dispatch + readable snapshot, for the hook that owns the SSE stream. */
export function useAgentDispatch(): Pick<
  AgentActionsContextValue,
  "dispatch" | "snapshotReadables"
> {
  const { dispatch, snapshotReadables } = useAgentActionsContext("useAgentDispatch");
  return { dispatch, snapshotReadables };
}
