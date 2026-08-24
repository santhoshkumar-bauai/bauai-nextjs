# 3. The LangGraph layer

## 3.1 The shared tool loop

Every conversational agent in this codebase compiles from one file:
[`lib/ai/agent/tool-loop.ts`](../../lib/ai/agent/tool-loop.ts). Read it before
anything else.

```
trim → model(tools bound) ─ has tool_calls & under cap ─► tools → model
                          ─ has tool_calls & cap hit ───► finalize → END
                          ─ no tool_calls ──────────────► END
```

Compiled shape:

```ts
const graph = new StateGraph(ToolLoopState)
  .addNode("beginTurn", nodes.beginTurn)
  .addNode("model",     nodes.model)
  .addNode("tools",     nodes.tools)      // ToolNode
  .addNode("finalize",  nodes.finalize)
  .addEdge(START, "beginTurn")
  .addEdge("beginTurn", "model")
  .addConditionalEdges("model", (state) => {
    const route = nodes.routeAfterModel(state);
    return route === "done" ? END : route;
  })
  .addEdge("tools", "model")
  .addEdge("finalize", END);

return graph.compile({ checkpointer: input.checkpointer });
```

### Why not `createReactAgent`?

Stated in the source, and all three reasons hold up:

1. **An explicit iteration cap with a forced-finalize path.** When the cap is
   hit, the model is re-invoked with **no tools bound**, so it has no choice but
   to answer in prose. The prebuilt agent has no equivalent — it either loops or
   errors.
2. **A per-turn fresh system prompt, never checkpointed.** Prompt fixes apply
   retroactively to conversations already in flight. `createReactAgent`'s prompt
   API does not give the same guarantee cleanly.
3. **No dependency on the prebuilt's prompt API**, which has changed shape more
   than once across LangGraph versions.

`ToolNode` *is* reused, so tool exceptions become `ToolMessage`s rather than
crashing the graph (`handleToolErrors` defaults to `true`).

### Two export shapes

```ts
export function createToolLoopNodes(input: ToolLoopNodesInput)  // loose parts
export function buildToolLoopGraph(input: ToolLoopGraphInput)   // standalone graph
```

Clara, Dora and Dora-Spreadsheet call `buildToolLoopGraph`. Otto calls
`createToolLoopNodes` and wires the individual nodes (`loop.model`,
`loop.tools`, `loop.finalize`, `loop.routeAfterModel`) into its own wider
machine. That split is the reason there is exactly one implementation of the
Gemini history hygiene rather than four.

### The route is not node names

```ts
export type ToolLoopRoute = "tools" | "finalize" | "done";
```

`done` means "the model has answered" — the *host* graph decides what that
means. For Clara it maps to `END`; for Otto it maps to the `verify` node. This
is a small, correct piece of design: the loop stays reusable because it does not
hard-code its own termination.

## 3.2 State: annotations and reducers

```ts
// lib/ai/agent/tool-loop.ts
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
```

Two reducer idioms, both used throughout:

- **concat** (`messages`) — append-only, the standard message channel.
- **replace** (`iterations`, and most of Otto's channels) — last write wins.

The spec is exported as a **raw object**, not just the built root, so richer
agents can spread it:

```ts
// lib/ai/otto/state.ts
export const OttoState = Annotation.Root({
  ...toolLoopStateSpec,
  userProfile:            Annotation<OttoProfile>({ reducer: (l, r) => ({ ...l, ...r }), default: () => ({}) }),
  pendingQuestion:        replace<ProfileQuestionId | null>(() => null),
  plannedMilestones:      replace<MilestoneId[]>(() => []),
  currentMilestoneId:     replace<MilestoneId | null>(() => null),
  completedMilestoneIds:  replace<MilestoneId[]>(() => []),
  attemptCount:           replace<number>(() => 0),
  status:                 replace<OttoStatus>(() => "profiling"),
  justAdvanced:           replace<boolean>(() => false),
  autoAdvances:           replace<number>(() => 0),
});
```

`userProfile` is the one **merge** reducer in the codebase, and the comment
explains why: each turn answers one profile question and must not erase the
previous answers.

Every loop node is typed against the *narrow* `ToolLoopStateType`, so it
structurally accepts any wider state. That is what lets Otto pass `OttoState`
into `loop.model` without a cast.

### The append-only consequence

`messages` uses `concat`, so **graph state only ever grows**. Trimming happens
at read time inside the model node, never in state:

```ts
// Resetting the iteration counter is this node's entire job — it re-arms
// the tool-loop cap at the start of every turn. History trimming happens
// at model-call time in contextWindow() (a concat reducer can't shrink).
const beginTurnNode = () => ({ iterations: 0 });
```

This is correct for the *model* but has a storage consequence: checkpoints for a
long-lived thread grow without bound. See
[§6.2](06-review.md#62-checkpoints-grow-forever-and-the-read-index-is-the-wrong-shape).

## 3.3 Gemini history hygiene

Two functions exist because Gemini **hard-rejects** malformed function-call
pairings. They are exported for tests and re-exported from `agent/graph.ts` for
older call sites.

### `sanitizeToolPairs(messages)`

Drops broken tool-call/response pairings before a model call.

Why it must exist: the finalize path leaves the model's **dangling tool-call
request** in checkpointed state — a concat reducer can only append, so the
request cannot be removed once written. Gemini then answers any subsequent turn
with *"Please ensure that function call turn comes immediately after…"*.
Sanitizing at read time also heals threads that were poisoned before the fix
existed.

```ts
export function sanitizeToolPairs(messages: BaseMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.getType() === "tool") {
      // keep only tool responses that directly follow their calling AI message
      let j = out.length - 1;
      while (j >= 0 && out[j].getType() === "tool") j -= 1;
      if (j >= 0 && hasToolCalls(out[j])) out.push(message);
      continue;
    }
    if (hasToolCalls(message)) {
      // keep only tool-call messages whose responses actually follow
      if (messages[i + 1]?.getType() === "tool") out.push(message);
      continue;
    }
    out.push(message);
  }
  return out;
}
```

### `windowFromUserTurn(messages, max)`

A plain `slice(-max)` regularly lands mid tool-loop — one global-chat turn can
be ~18 messages. The window then *starts* on a function-call turn whose
responses follow it, which `sanitizeToolPairs` legitimately keeps (locally the
pairing is intact), and Gemini rejects the request because a function-call turn
must follow a user turn or a function-response turn — not be first.

So the cut moves forward to the **oldest user turn still inside the window**,
falling back to the newest user turn *before* the cut if the window contains
none. A window slightly over `max` beats a guaranteed 400.

### `hasToolCalls` is duck-typed on purpose

```ts
function hasToolCalls(message: BaseMessage | undefined): boolean {
  // Duck-typed on purpose: under streamEvents the model yields AIMessageChunk,
  // which is NOT instanceof AIMessage — an instanceof check silently ends the
  // loop before any tool ever runs.
  if (!message || message.getType() !== "ai") return false;
  const calls = (message as { tool_calls?: unknown[] }).tool_calls;
  return Array.isArray(calls) && calls.length > 0;
}
```

This one is worth memorizing. `instanceof AIMessage` fails for
`AIMessageChunk`, and the failure mode is silent: the loop routes to `done`
before any tool executes and the user gets a confident answer built on nothing.

## 3.4 The finalize path

```ts
const finalizeNode = async (state, config) => {
  const messages = hasToolCalls(lastMessage(state))
    ? state.messages.slice(0, -1)      // strip the dangling tool-call request
    : state.messages;
  const window = await resolveMediaParts(contextWindow(messages), mediaCache);
  const nudge = new HumanMessage(
    "Stop gathering. Using ONLY the information collected above, give your final " +
    "answer to my original question now, in plain prose. If something could not be " +
    "determined, say so explicitly. Do not request any tools.",
  );
  let response = await model.invoke([resolvePrompt(state), ...window, nudge], config);
  if (!textFromContent(response.content).trim()) {
    response = await model.invoke([resolvePrompt(state), ...window, nudge], config);  // one retry
  }
  return { messages: [response] };
};
```

Note `model.invoke`, not `boundModel.invoke` — **no tools bound**. The explicit
nudge is not belt-and-braces: a history full of function-call/response pairs
makes Gemini pattern-continue with more `functionCall` parts even when no tools
are declared, and without the nudge the turn ends with zero user-visible text.
The single retry exists because Gemini occasionally needs a second pass to break
the pattern.

Finalize is reached from two conditions, and the second is easy to miss:

```ts
const routeAfterModel = (state): ToolLoopRoute => {
  const last = lastMessage(state);
  if (!hasToolCalls(last)) {
    // A thinking model can exhaust its output budget on reasoning and
    // "answer" with zero text. Route through finalize instead of ending
    // on an empty reply.
    return textFromContent(last?.content).trim() ? "done" : "finalize";
  }
  return state.iterations >= maxIterations ? "finalize" : "tools";
};
```

An empty answer from a thinking model is treated as a failure to answer, not as
an answer.

## 3.5 Checkpointing

```ts
// lib/ai/agent/checkpointer.ts
let saver: MongoDBSaver | null = null;

export async function getClaraCheckpointer(): Promise<MongoDBSaver> {
  if (saver) return saver;
  const client = await getIngestionClient();
  saver = new MongoDBSaver({
    client: client as never,   // bundled mongodb types lag the app's driver
    dbName: ingestionEnv.mongoDb,
    checkpointCollectionName: "agent_checkpoints",
    checkpointWritesCollectionName: "agent_checkpoint_writes",
  });
  return saver;
}
```

One module-level singleton, shared by **all four agents** — the name
`getClaraCheckpointer` is historical, not scoped. Collections are global; the
isolation comes entirely from the thread key.

### Thread keys are the security boundary

```ts
// lib/ai/agent/threads.ts
export function tenderThreadKey(tenantId, tenderId) {
  return `clara:${tenantId.toHexString()}:${tenderId.toHexString()}`;
}
export function globalThreadKey(threadId) {
  return `clarag:${threadId.toHexString()}`;
}
// dora/threads.ts  → `dora:…`
// otto/threads.ts  → `otto:{tenantId}:{userId}`
```

Rules, all enforced:

- **Always derived server-side.** No route accepts a `thread_id`. Cross-tenant
  checkpoint access is therefore inexpressible through the API surface, not
  merely rejected.
- **The tender format is FROZEN.** Checkpoints are keyed by the exact string.
  Changing it orphans every ongoing conversation. The one deliberate break so
  far (the Clara rebrand) was paired with a full wipe via
  `npm run ai:reset:chat`. A unit test pins the format.
- **Namespace prefixes keep agents disjoint** while sharing collections.

### Reading state without running the graph

Otto needs to render a progress checklist server-side:

```ts
// lib/ai/otto/service.ts
const graph = await buildOttoGraph(ctx);
const snapshot = await graph.getState({
  configurable: { thread_id: onboardingThreadKey(ctx.tenantId, ctx.userId) },
});
```

Note the cost: `getState` still requires compiling a graph, which builds the
model and the tool registry. See
[§6.6](06-review.md#67-a-graph-is-compiled-on-every-request).

### Deleting checkpoints

`threads.ts` deletes by raw collection query:

```ts
async function deleteCheckpoints(threadKey: string): Promise<void> {
  const db = await getIngestionDb();
  await db.collection("agent_checkpoints").deleteMany({ thread_id: threadKey });
  await db.collection("agent_checkpoint_writes").deleteMany({ thread_id: threadKey });
}
```

`MongoDBSaver` in 1.4.0 implements `deleteThread(threadId)` — see
[§6.3](06-review.md#66-checkpoint-deletion-is-hand-rolled-in-three-places).

### Two stores, reconciled — the Otto pattern

The graph checkpoint owns the live conversation and working state.
`AccountProfile.onboardingAgent` owns the durable "should Otto appear, and how
far did they get", because a server component must be able to read it *without
compiling a graph*, and it must survive a checkpoint reset.
[`otto/service.ts`](../../lib/ai/otto/service.ts) is the only place the two are
reconciled, and it never downgrades a `dismissed` profile back to
`in_progress` — the user's decision to leave outranks anything the graph
subsequently does.

Copy this pattern for any future agent whose progress must outlive its
conversation.

## 3.6 Streaming: `streamEvents` v2

The turn runner consumes a single event iterator:

```ts
const stream = graph.streamEvents(
  { messages: [new HumanMessage({ content: turnContent })] },
  { version: "v2", configurable: { thread_id: threadKey }, signal },
);
```

Events consumed, and what each becomes:

| Event | Used for |
|---|---|
| `on_chat_model_stream` | `event.data.chunk.content` → `textFromContent` → SSE `token` |
| `on_chat_model_end` | `llmCalls++`, `usage_metadata` token accounting, authoritative final text |
| `on_tool_start` | SSE `tool` start; `toolStarts.set(event.run_id, Date.now())` |
| `on_tool_end` | duration from `run_id`, `resultCount` from parsed output, drain `tenderRefs` + `uiCalls` |
| `on_chain_end` | Otto only — a node's state patch → SSE `state` |

**`config` must be forwarded into every model invocation.** This is the single
easiest thing to break:

```ts
// Forwarding `config` into every model invocation is what propagates the
// callback manager — without it, streamEvents sees no token/tool events.
const response = await boundModel.invoke([resolvePrompt(state), ...window], config);
```

Drop `config` and the turn still completes, the model still answers, and the
user sees nothing stream. It also silently kills any Langfuse callback handler
attached to the run — which is why [§7](07-observability-langfuse.md) leans on
this so hard.

### Distinguishing node state from outer chain state

```ts
} else if (callbacks?.onState && event.event === "on_chain_end") {
  const node = (event.metadata as { langgraph_node?: string })?.langgraph_node;
  ...
}
```

`langgraph_node` is absent on the outer chain events. Without that check the
whole state would be echoed on every step.

## 3.7 Graph topology reference

### Clara / Dora / Dora-Spreadsheet — the plain loop

```
        START
          │
      beginTurn            iterations = 0
          │
          ▼
    ┌── model ◄────────────┐          bound to N tools
    │     │                │
    │     ├─ tool_calls & iterations < cap ──► tools ──┘
    │     ├─ tool_calls & iterations >= cap ─► finalize ──► END
    │     ├─ no tool_calls, text present ────► END
    │     └─ no tool_calls, empty ───────────► finalize ──► END
```

### Otto — the loop embedded in an onboarding machine

```
        START
          │
      beginTurn            iterations = 0, autoAdvances = 0, justAdvanced = false
          │
   ┌──────┴──────┬─────────────┐        by state.status
   ▼             ▼             ▼
profiling     planning       guiding
   │             │             │
profile ──┐    plan ──────────►│
   │      │                    │
   │  pendingQuestion?         │
   │      └── yes ──► END      │
   │                           ▼
   └── no ──► plan ──────► ┌── guide ◄───────┐   (= loop.model)
                           │     │           │
                           │     ├─ tools ───┘
                           │     ├─ finalize ─► verify
                           │     └─ done ────► verify
                           │                     │
                           │      justAdvanced && autoAdvances <= 1
                           └─────────────────────┤
                                                 └─► END
```

## 3.8 LangGraph features we do *not* use

Worth knowing, because several are relevant to
[§6](06-review.md):

| Feature | Status here |
|---|---|
| `interrupt()` / human-in-the-loop | **Deliberately avoided.** Otto asks a question and ends the turn instead; resuming with `Command({resume})` cannot be expressed through the shared SSE turn runner, and forking the runner per agent was judged worse. |
| `Send` / map-reduce fan-out | Not used. Parallel work (match judging, GAEB fill batches) is hand-rolled with concurrency env knobs, outside any graph. |
| `Command` returned from tools | Not used. Tools mutate context collectors instead. |
| Subgraphs | Not used. Otto composes at the *node* level (`createToolLoopNodes`) rather than embedding a compiled subgraph. |
| `RetryPolicy` / `CachePolicy` / `setNodeDefaults` | Not used. No node has a retry policy. |
| `recursionLimit` | **Never set.** Runs on the default of 25. See [§6.1](06-review.md#61-the-recursion-limit-is-two-supersteps-away). |
| `BaseStore` (long-term memory) | Not used. Cross-thread memory would go here. |
| `streamMode: "messages" \| "updates" \| "custom"` | Not used; everything goes through `streamEvents` v2. |
| `REMOVE_ALL_MESSAGES` / `RemoveMessage` | Not used — the custom concat reducer cannot express removal. |
