import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  Annotation,
  END,
  START,
  StateGraph,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

import { resolveMediaParts } from "./attachments.ts";
import { textFromContent } from "./content.ts";

/**
 * The shared chat-agent graph shape: a minimal, capped tool loop.
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
 *
 * Extracted from Clara's graph so every agent (Clara, Dora) compiles the same
 * loop — including the Gemini history hygiene that exists because Gemini
 * hard-rejects malformed function-call turn pairings.
 */

/**
 * The loop's own state channels, exported as a raw spec so richer agents can
 * spread them into a wider `Annotation.Root` and still reuse the nodes below:
 *
 *   Annotation.Root({ ...toolLoopStateSpec, currentMilestoneId: ... })
 *
 * Every node here is typed against the NARROW state, so it accepts any state
 * that structurally extends it.
 */
export const toolLoopStateSpec = {
  messages: Annotation<BaseMessage[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  iterations: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
};

const ToolLoopState = Annotation.Root(toolLoopStateSpec);

export type ToolLoopStateType = typeof ToolLoopState.State;

function lastMessage(state: ToolLoopStateType): BaseMessage | undefined {
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

/**
 * Trim history to the model's window, always opening on a user turn.
 *
 * A plain `slice(-max)` regularly lands mid tool-loop on multi-turn global
 * chats (one turn can be ~18 messages), leaving the window to start on a
 * function-call turn whose responses follow it — which `sanitizeToolPairs`
 * legitimately keeps, since locally the pairing is intact. Gemini then rejects
 * the whole request: a function-call turn must come after a user turn or a
 * function-response turn, and here it is the FIRST turn. So the cut moves
 * forward to the oldest user turn still inside the window.
 *
 * If the cut passed every user turn, it falls back to the newest one before
 * the cut — a window slightly over `max` beats a guaranteed 400. Exported for
 * tests.
 */
export function windowFromUserTurn(
  messages: BaseMessage[],
  max: number,
): BaseMessage[] {
  const cut = Math.max(0, messages.length - max);
  let begin = -1;
  for (let i = cut; i < messages.length; i += 1) {
    if (messages[i].getType() === "human") {
      begin = i;
      break;
    }
  }
  if (begin < 0) {
    for (let i = cut - 1; i >= 0; i -= 1) {
      if (messages[i].getType() === "human") {
        begin = i;
        break;
      }
    }
  }
  return sanitizeToolPairs(messages.slice(begin < 0 ? cut : begin));
}

/**
 * Supersteps a tool loop can take, plus headroom.
 *
 * `beginTurn` + n × (`model`, `tools`) + `model` + `finalize`, and every node
 * is its own superstep. LangGraph's default `recursionLimit` is 25, which left
 * Clara at 21 and Otto at 22 — three supersteps of headroom on a limit nobody
 * had set, and raising AI_AGENT_MAX_ITERATIONS by one would have pushed Otto
 * past it in production rather than in CI.
 *
 * `extraNodes` covers host graphs that wrap the loop: Otto adds plan, verify
 * and an auto-advance pass.
 */
export function toolLoopRecursionLimit(maxIterations: number, extraNodes = 0): number {
  return 2 * maxIterations + 4 + extraNodes;
}

export interface ToolLoopNodesInput {
  model: BaseChatModel;
  tools: StructuredToolInterface[];
  /**
   * Either a fixed prompt, or a function of state for agents whose prompt
   * depends on where they are (Otto's changes with the current milestone).
   * Resolved per model call, never checkpointed, so prompt edits apply to
   * conversations already in flight.
   */
  systemPrompt: SystemMessage | ((state: ToolLoopStateType) => SystemMessage);
  maxIterations: number;
  /**
   * Hard message ceiling, and the whole window strategy when
   * `historyMaxTokens` is unset. Keep it: `windowFromUserTurn` encodes a
   * paid-for Gemini 400 that a naive replacement would reintroduce.
   */
  historyMaxMessages: number;
  /**
   * Token budget for the model-visible window. When set, it supersedes the
   * message count — 30 messages is under two turns of a tool-heavy chat, and
   * on a million-token context that throws away almost the whole conversation
   * for no reason. Unset keeps today's behaviour exactly.
   */
  historyMaxTokens?: number;
}

export interface ToolLoopGraphInput extends ToolLoopNodesInput {
  checkpointer: BaseCheckpointSaver;
}

/**
 * Rough token count for a message window.
 *
 * Deliberately local rather than `tokenCounter: model`, which LangChain
 * supports and which would be wrong here twice over. It resolves the model to
 * a tiktoken encoding and fetches it from `tiktoken.pages.dev` on first use —
 * a network call on the hot path of every model invocation — and its
 * `getNumTokens` sums only `type: "text"` blocks, so images and files count as
 * ZERO. A fill-agent window carrying 50 rendered pages would measure as
 * nothing and never trim, which is precisely the window that needs trimming.
 *
 * Accuracy beyond "the right order of magnitude" buys nothing: the budget is
 * a safety margin, not an invoice.
 */
const CHARS_PER_TOKEN = 3.5; // German prose and JSON both run denser than English
const IMAGE_TOKENS = 1_100; // one rendered page at default detail
const FILE_TOKENS = 4_000; // a PDF the model reads natively

export function approxMessageTokens(messages: BaseMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += 4; // role and framing overhead

    const content = message.content;
    if (typeof content === "string") {
      total += Math.ceil(content.length / CHARS_PER_TOKEN);
    } else if (Array.isArray(content)) {
      for (const part of content as unknown[]) {
        if (typeof part === "string") {
          total += Math.ceil(part.length / CHARS_PER_TOKEN);
          continue;
        }
        const block = part as { type?: string; text?: string; mimeType?: string };
        if (block.type === "text" && typeof block.text === "string") {
          total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
        } else if (block.type === "image_url") {
          total += IMAGE_TOKENS;
        } else if (block.type === "media_ref") {
          // Trimming runs BEFORE resolveMediaParts, so attachments are still
          // cheap refs here — charge what they will cost once materialized.
          total += block.mimeType?.startsWith("image/") ? IMAGE_TOKENS : FILE_TOKENS;
        } else if (block.type === "file") {
          total += FILE_TOKENS;
        }
      }
    }

    // Always, never inside the content branches: a tool-calling turn carries
    // its arguments beside an empty string content, so charging these only for
    // array content would score the entire tool loop at ~0.
    const toolCalls = (message as { tool_calls?: unknown[] }).tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      total += Math.ceil(JSON.stringify(toolCalls).length / CHARS_PER_TOKEN);
    }
  }
  return total;
}

/**
 * Where the loop goes after a model call. Deliberately NOT expressed as graph
 * node names: `done` means "the model has answered", and each host graph
 * decides what that means — END for a plain chat agent, a verification node
 * for one that has to check the answer against real data.
 */
export type ToolLoopRoute = "tools" | "finalize" | "done";

/**
 * The capped tool loop as loose parts, for graphs that need it as a SUBGRAPH
 * rather than the whole machine. `buildToolLoopGraph` below is the two-line
 * wrapper that wires these into the standalone shape Clara and Dora use.
 */
export function createToolLoopNodes(input: ToolLoopNodesInput) {
  const { model, tools, maxIterations } = input;
  const boundModel = model.bindTools ? model.bindTools(tools) : model;

  const resolvePrompt =
    typeof input.systemPrompt === "function"
      ? input.systemPrompt
      : () => input.systemPrompt as SystemMessage;

  // Resetting the iteration counter is this node's entire job — it re-arms
  // the tool-loop cap at the start of every turn. History trimming happens
  // at model-call time in contextWindow() (a concat reducer can't shrink).
  const beginTurnNode = () => ({ iterations: 0 });

  // Repairs both slice damage (a window starting mid tool-loop) and dangling
  // tool-call turns left in state by the finalize path.
  const contextWindow = async (messages: BaseMessage[]): Promise<BaseMessage[]> => {
    if (!input.historyMaxTokens) {
      return windowFromUserTurn(messages, input.historyMaxMessages);
    }

    // Bound the work first: without this, trimMessages walks the entire
    // thread on every superstep of every turn.
    const ceiling = Math.max(input.historyMaxMessages * 4, 120);
    const capped = messages.slice(-ceiling);

    const { trimMessages } = await import("@langchain/core/messages");
    const trimmed = await trimMessages(capped, {
      maxTokens: input.historyMaxTokens,
      strategy: "last",
      // Same intent as windowFromUserTurn: a function-call turn may not open
      // the window, or Gemini rejects the whole request.
      startOn: "human",
      tokenCounter: approxMessageTokens,
      // `includeSystem` would be a no-op — the system prompt is not in state,
      // it is prepended per model call below.
    });

    // trimMessages returns [] when even the newest human turn exceeds the
    // budget. windowFromUserTurn deliberately overshoots in that case ("a
    // window slightly over max beats a guaranteed 400"); keep that.
    const window = trimmed.length > 0 ? trimmed : capped.slice(-1);

    // Always, and after trimming. trimMessages understands tool pairs, but not
    // the DANGLING tool-call request the finalize path leaves in checkpointed
    // state — a concat reducer can only append.
    return sanitizeToolPairs(window);
  };

  // Attached images are checkpointed as tiny media_ref parts; the base64
  // payload is materialized here, per model call, cached for the turn.
  const mediaCache = new Map<string, string>();

  // Forwarding `config` into every model invocation is what propagates the
  // callback manager — without it, streamEvents sees no token/tool events.
  const modelNode = async (state: ToolLoopStateType, config: RunnableConfig) => {
    const window = await resolveMediaParts(await contextWindow(state.messages), mediaCache);
    const response = await boundModel.invoke([resolvePrompt(state), ...window], config);
    return { messages: [response], iterations: state.iterations + 1 };
  };

  const finalizeNode = async (state: ToolLoopStateType, config: RunnableConfig) => {
    // Cap reached with the model still asking for tools (or an empty
    // answer): strip the dangling tool-call request and force plain prose
    // with no tools bound. The explicit nudge matters — a history full of
    // function-call/response pairs makes Gemini pattern-continue with MORE
    // functionCall parts even when no tools are declared; without it the
    // turn ends with zero user-visible text.
    const messages = hasToolCalls(lastMessage(state))
      ? state.messages.slice(0, -1)
      : state.messages;
    const window = await resolveMediaParts(await contextWindow(messages), mediaCache);
    const nudge = new HumanMessage(
      "Stop gathering. Using ONLY the information collected above, give your final answer to my original question now, in plain prose. If something could not be determined, say so explicitly. Do not request any tools.",
    );
    let response = await model.invoke([resolvePrompt(state), ...window, nudge], config);
    if (!textFromContent(response.content).trim()) {
      // One retry — Gemini occasionally needs a second pass to break the
      // function-call pattern.
      response = await model.invoke([resolvePrompt(state), ...window, nudge], config);
    }
    return { messages: [response] };
  };

  const routeAfterModel = (state: ToolLoopStateType): ToolLoopRoute => {
    const last = lastMessage(state);
    if (!hasToolCalls(last)) {
      // A thinking model can exhaust its output budget on reasoning and
      // "answer" with zero text. Route through finalize (no tools bound,
      // must produce prose) instead of ending on an empty reply.
      return textFromContent(last?.content).trim() ? "done" : "finalize";
    }
    return state.iterations >= maxIterations ? "finalize" : "tools";
  };

  return {
    beginTurn: beginTurnNode,
    model: modelNode,
    tools: new ToolNode(tools),
    finalize: finalizeNode,
    routeAfterModel,
  };
}

export function buildToolLoopGraph(input: ToolLoopGraphInput) {
  const nodes = createToolLoopNodes(input);

  const graph = new StateGraph(ToolLoopState)
    .addNode("beginTurn", nodes.beginTurn)
    .addNode("model", nodes.model)
    .addNode("tools", nodes.tools)
    .addNode("finalize", nodes.finalize)
    .addEdge(START, "beginTurn")
    .addEdge("beginTurn", "model")
    .addConditionalEdges("model", (state) => {
      const route = nodes.routeAfterModel(state);
      return route === "done" ? END : route;
    })
    .addEdge("tools", "model")
    .addEdge("finalize", END);

  return graph.compile({ checkpointer: input.checkpointer });
}
