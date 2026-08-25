# 6. Implementation review

An honest read of the LangChain/LangGraph implementation as of this writing.
Findings are ranked by expected damage, each with the evidence that produced it
and a concrete fix. Claims about library behaviour were checked against the
installed versions in `node_modules`, not from memory.

## 6.0 What is genuinely good — keep it

Before the criticism, the things that would be a mistake to "refactor":

1. **One tool loop, four agents.** [`tool-loop.ts`](../../lib/ai/agent/tool-loop.ts)
   exports both a compiled graph and loose nodes, so Otto reuses the exact same
   model node rather than reimplementing it. The header comment records what
   happened the one time someone did reimplement it (blank replies, because the
   Gemini history hygiene went with it). This is the highest-value piece of
   design in the subsystem.
2. **Rejecting `createReactAgent` for stated reasons.** The forced-finalize path
   (re-invoke with **no tools bound**) is a genuinely better failure mode than
   looping or erroring, and it does not exist in the prebuilt.
3. **The role registry.** One env var moves any model or provider, with fill
   roles pinned so document generation cannot drift when the chat model is
   upgraded. This is exactly the structural answer to the "8 runtimes each
   calling Gemini their own way" problem the migration proposal describes.
4. **Server-derived thread keys.** Cross-tenant checkpoint access is
   *inexpressible*, not merely rejected. The frozen-format rule with a pinning
   unit test is the right level of paranoia.
5. **Comments that record incidents.** `geminiUsesFixedSampling`, the duck-typed
   `hasToolCalls`, `windowFromUserTurn`'s rationale, Otto's `beginTurn` — each
   is a paid-for bug with the receipt attached. Do not let these be stripped as
   "noise".
6. **`FakeToolCallingChatModel`'s shared queue across `bindTools`.** A small
   thing that makes the finalize path actually testable.
7. **Otto's "schema constrains, code enforces, failure degrades" planner.** The
   right shape for every future LLM-plans-something feature.

---

## 6.1 The recursion limit is two supersteps away

> **RESOLVED.** `runChatTurn` now sets a superstep budget for every graph via
> `toolLoopRecursionLimit(maxIterations, extraNodes)`, sized for the widest
> loop plus Otto's extra nodes, and a test per graph fails when a cap outgrows
> it. The fill agent's private wrapper is gone in favour of the shared formula.

**Severity: P1 · Verified · Evidence:** `recursionLimit` appears nowhere in
`lib/`, `app/` or `workers/`. `@langchain/langgraph@1.4.9` sets
`DEFAULT_RECURSION_LIMIT = 25` (`dist/pregel/utils/config.js:36`).

Superstep counts, since every node in these graphs is its own superstep:

| Graph | Formula | At current settings |
|---|---|---|
| Clara tender (`maxIterations` 8) | `2·n + 1` | 17 |
| Clara global (`maxIterations` 10) | `2·n + 1` | **21** |
| Otto worst case (`maxIterations` 8) | `2 + 2·n + 4` | **22** |

Otto's worst path: `beginTurn` → `plan` → 8 × (`guide` + `tools`) → `finalize`
→ `verify` → auto-advance `guide` → `finalize` → `verify` → `END`.

So we run with **3–4 supersteps of headroom on a limit nobody has set**. The
sharp edge:

> Setting `AI_AGENT_MAX_ITERATIONS=10` — a value that already exists in this
> codebase as `AI_AGENT_GLOBAL_MAX_ITERATIONS` — pushes Otto to ~26 supersteps
> and every Otto turn throws `GraphRecursionError`.

And because [`sse-turn.ts`](../../lib/ai/agent/sse-turn.ts) collapses all errors
to `"failed"`, the symptom is "onboarding is broken" with no clue in the client.

**Fix.** Set the limit explicitly, derived from the cap rather than guessed:

```ts
// lib/ai/agent/tool-loop.ts
export function toolLoopRecursionLimit(maxIterations: number, extraNodes = 0): number {
  // beginTurn + (model,tools)×n + finalize, plus the host graph's own nodes,
  // plus headroom for one auto-advance style re-entry.
  return 2 * maxIterations + 4 + extraNodes;
}
```

```ts
// lib/ai/agent/service.ts
const config = {
  configurable: { thread_id: input.threadKey },
  recursionLimit: input.recursionLimit ?? 40,
  signal,
};
```

Then add a test that asserts the limit exceeds the worst path for each graph, so
raising an iteration cap fails CI instead of production. Also map
`GraphRecursionError` to its own client-visible key (see [§6.5](#65-every-failure-is-failed)).

---

## 6.2 Checkpoints grow forever, and the read index is the wrong shape

**Severity: P1 · Verified**

Three separate problems in the same place.

### (a) No TTL

`agent_checkpoints` and `agent_checkpoint_writes` have no expiry. Every
superstep of every turn of every thread, for every tenant, forever. Tender
threads are company-shared and never deleted (a "clear" resets the counters and
deletes checkpoints, but only on explicit user action). Global threads are
deleted with the thread. Otto threads persist after onboarding completes.

`MongoDBSaver` in 1.4.0 takes a `ttl` (seconds) and, when set, enables
`upserted_at` timestamps and creates TTL indexes on both collections
(`dist/checkpoint.js:32,69`).

### (b) `setup()` is never called, and the hand-rolled index is weaker

[`lib/ai/db/indexes.ts:207`](../../lib/ai/db/indexes.ts) says:

```ts
// LangGraph checkpoint collections are created implicitly by MongoDBSaver
// and read/deleted by thread_id (thread reset) — index them here since the
// saver never does.
for (const name of ["agent_checkpoints", "agent_checkpoint_writes"]) {
  await db.collection(name).createIndex({ thread_id: 1 }, { name: "ix_thread" });
}
```

**The comment is now stale.** `MongoDBSaver.setup()` exists, is idempotent, safe
to call concurrently, and creates:

```
agent_checkpoints        { thread_id: 1, checkpoint_ns: 1, checkpoint_id: -1 }  thread_ns_checkpoint_idx
agent_checkpoint_writes  { thread_id: 1, checkpoint_ns: 1, checkpoint_id: 1,
                           task_id: 1, idx: 1 }                                 thread_ns_checkpoint_task_idx
```

That matters because the hot read is:

```js
db.collection("agent_checkpoints")
  .find({ thread_id, checkpoint_ns })
  .sort("checkpoint_id", -1)
  .limit(1)
```

With only `{thread_id: 1}`, Mongo fetches every checkpoint for the thread and
sorts them in memory on **every single superstep**. With the compound index it
is one index seek. On a long tender thread that is the difference between a
constant-time read and one that degrades with conversation length — and the
graph does this read once per node.

### (c) The concat reducer cannot shrink

`messages` uses `(left, right) => left.concat(right)`. Trimming happens only at
model-call time via `contextWindow()`. State itself only grows, and each
checkpoint serializes the **whole** message array — including inlined document
text from attachments.

`@langchain/langgraph@1.4.9` exports `messagesStateReducer` (aliased
`addMessages`), `REMOVE_ALL_MESSAGES`, and `@langchain/core` exports
`RemoveMessage` — i.e. a reducer that *can* express removal.

**Fix, in order of effort:**

```ts
// 1. lib/ai/agent/checkpointer.ts — TTL + proper indexes
const CHECKPOINT_TTL_SECONDS = 60 * 60 * 24 * 90;   // 90 days of inactivity

export async function getAgentCheckpointer(): Promise<MongoDBSaver> {
  if (saver) return saver;
  const client = await getIngestionClient();
  saver = new MongoDBSaver({
    client: client as never,
    dbName: ingestionEnv.mongoDb,
    checkpointCollectionName: "agent_checkpoints",
    checkpointWritesCollectionName: "agent_checkpoint_writes",
    ttl: CHECKPOINT_TTL_SECONDS,
  });
  return saver;
}
```

```ts
// 2. scripts/ai-bootstrap.mts — call setup(), surface its errors
const errors = await (await getAgentCheckpointer()).setup();
if (errors.length > 0) console.error("[ai-bootstrap] checkpoint setup:", errors);
```

Then delete the hand-rolled `ix_thread` loop from `db/indexes.ts` (or keep it —
it is harmless — but fix the comment either way).

3. **Longer term:** switch `messages` to `messagesStateReducer` and have
   `beginTurn` emit `RemoveMessage`s for anything already outside the context
   window. State then tracks what the model actually sees, `sanitizeToolPairs`
   stops having to heal dangling tool calls on every read, and checkpoint size
   becomes bounded. This is a behaviour change to a frozen-key store — do it
   behind a `graphVersion` bump, not silently.

---

## 6.3 The effective memory window is much shorter than 30 messages

**Severity: P2 · Design**

`AI_AGENT_HISTORY_MAX_MESSAGES` = 30, described as "conversation messages kept
in model context". But `sse-turn.ts` notes that a single global-chat turn can be
**~18 messages** (one human + up to 10 AI tool-call turns + their `ToolMessage`
responses + the answer).

So "30 messages" is, for a tool-heavy conversation, **less than two turns of
memory** — and `windowFromUserTurn` correctly moves the cut *forward* to a user
turn, which can shrink it further. Users will experience Clara forgetting what
they said three questions ago, and nothing in the metrics will show why.

Meanwhile the cap is measured in the wrong unit: 30 messages of one-line tool
results and 30 messages containing a 20 000-char `read_tender_document` result
are wildly different token counts, and the second is what actually blows a
context window.

**Fix — DONE.** Token-budget trimming, behind `AI_AGENT_HISTORY_MAX_TOKENS`.
Unset keeps the message-count window exactly as it was; the Azure roles set it
to 200 000. `windowFromUserTurn` stays as the fallback and as the hard ceiling,
because it encodes a Gemini 400 a naive swap would reintroduce.

Two corrections to the fix as originally sketched here, both found while
implementing it:

**`tokenCounter: model` is wrong**, though `trimMessages` does accept a
`BaseLanguageModel`. It resolves the model to a tiktoken encoding and fetches
it from `https://tiktoken.pages.dev` on first use — a network call on the hot
path of every model invocation, which fails closed in a locked-down container.
Worse, `getNumTokens` sums only `type: "text"` blocks
(`language_models/base.js:205-209`), so **image and file blocks count as zero**.
A fill-agent window carrying 50 rendered pages would measure as nothing and
never trim, which is exactly the window that needs trimming. Use the local
media-aware `approxMessageTokens` instead.

**`includeSystem` is a no-op here.** The system prompt is not in `state.messages`
— it is prepended per model call — so the flag has nothing to include.

One more thing worth knowing: `trimMessages` returns `[]` when even the newest
human turn exceeds the budget. `windowFromUserTurn` deliberately overshoots in
that case ("a window slightly over max beats a guaranteed 400"), and the
implementation preserves that.

```ts
const trimmed = await trimMessages(capped, {
  maxTokens: input.historyMaxTokens,
  strategy: "last",
  startOn: "human",
  tokenCounter: approxMessageTokens,   // local; charges images and files
});
return sanitizeToolPairs(trimmed.length > 0 ? trimmed : capped.slice(-1));
```

---

## 6.4 Side-channel collectors vs graph state

**Severity: P2 · Design trade-off, not a bug**

`ctx.tenderRefs`, `ctx.uiCalls` and `ctx.citations` are mutable collectors on
the run context. Tools push; `runChatTurn` drains on `on_tool_end`.

What this costs:

- **They are not checkpointed.** If a turn's graph state is replayed (resume,
  time travel, or any future retry-from-checkpoint), the cards and UI calls do
  not come back — they are reconstructed only because `ctx.tenderRefs.list()` is
  read at the end of the same in-process turn.
- **They tie a tool to a process.** A tool cannot be moved into a subgraph, a
  worker, or a remote graph without losing its side effects.
- **They are invisible to the graph.** No node can route on "we already surfaced
  this tender".

LangGraph 1.4.9 offers two first-class alternatives, both available today:

```ts
// (a) a tool returns a Command to update state — ToolNode already handles this
import { Command } from "@langchain/langgraph";

const findTenders = tool(async ({ query }) => {
  const { text, refs } = await searchTenders(ctx, query);
  return new Command({
    update: { messages: [new ToolMessage({ content: text, tool_call_id })], tenderRefs: refs },
  });
}, { name: "find_tenders", schema: ... });
```

```ts
// (b) a custom stream channel, for things the UI needs but state should not hold
import { getWriter } from "@langchain/langgraph";
getWriter()?.({ type: "ui", calls });
// consumed via graph.stream(input, { streamMode: ["messages", "updates", "custom"] })
```

**Recommendation:** do not rip this out for its own sake. Do move `tenderRefs`
into graph state (option a) the first time you need replay, a subgraph, or
resume-after-abort — the current design is the thing blocking all three. Leave
`uiCalls` on the side channel; frontend actions are genuinely ephemeral and
should not be replayed.

---

## 6.5 Every failure is `"failed"`

> **RESOLVED**, except the correlation id. `classifyAiError`
> ([`lib/ai/agent/errors.ts`](../../lib/ai/agent/errors.ts)) reads typed errors
> first, then HTTP status, and provider prose only last — the old order was the
> reverse, and its regexes were shaped around Gemini's wording, so every Azure
> failure would have degraded to "something went wrong". Three codes are new
> and earned their place: `content_filtered` (Azure blocks ordinary German
> procurement text — runbook R10), `too_long`, and `loop_exhausted`. All six
> chat surfaces render them from one `AiErrors` catalog, so the next code needs
> no component change.

**Severity: P2 · Operability**

```ts
send({
  type: "error",
  message: error instanceof Error && /rate.?limit/i.test(error.message)
    ? "rate_limited" : "failed",
});
```

A `GraphRecursionError`, a Gemini `INVALID_ARGUMENT` on malformed history, a
Mongo checkpoint write failure, an OOM in a tool and a bug in `textFromContent`
are one indistinguishable string. Support gets "Clara says it failed"; there is
no id to correlate with a server log; the server log line is
`log.error("chat turn failed", { threadKey, error: String(error) })` — no
request id, no trace id, no user id.

Also note the substring match on `/rate.?limit/i` against `error.message`: it
works for the gateway's `RateLimitError` but is not guaranteed to match a
LangChain provider error, so lane-B rate limits may already be surfacing as
`"failed"`.

**Fix.**

1. Introduce an error taxonomy and map it once:

```ts
type ChatErrorKey = "rate_limited" | "too_long" | "provider_rejected"
                  | "loop_exhausted" | "timeout" | "failed";

function classifyTurnError(error: unknown): ChatErrorKey {
  if (error instanceof GraphRecursionError)              return "loop_exhausted";
  if (error instanceof RateLimitError)                   return "rate_limited";
  if (isProviderStatus(error, 429))                      return "rate_limited";
  if (isProviderStatus(error, 400))                      return "provider_rejected";
  ...
  return "failed";
}
```

2. Attach a **correlation id** to every turn, send it in the `error` frame, log
   it, and — once [§7](07-observability-langfuse.md) lands — make it the
   Langfuse trace id so support can paste it into the Langfuse search box.

---

## 6.6 Checkpoint deletion is hand-rolled in three places

**Severity: P3 · Verified**

`agent/threads.ts:211`, `dora/threads.ts:218` and `otto/threads.ts:92` each do:

```ts
await db.collection("agent_checkpoints").deleteMany({ thread_id: key });
await db.collection("agent_checkpoint_writes").deleteMany({ thread_id: key });
```

Three copies of the collection names, none of which knows about
`checkpoint_ns`. `BaseCheckpointSaver` in this version declares
`abstract deleteThread(threadId: string): Promise<void>` and `MongoDBSaver`
implements it (`dist/checkpoint.js:245`).

**Fix:** one helper, one call site each.

```ts
// lib/ai/agent/checkpointer.ts
export async function deleteAgentThread(threadKey: string): Promise<void> {
  await (await getAgentCheckpointer()).deleteThread(threadKey);
}
```

---

## 6.7 A graph is compiled on every request

**Severity: P3 · Performance / design**

`buildClaraGraph(ctx)` runs per turn: it constructs a chat model, builds the
full tool registry (20 zod schemas for Clara), builds the system prompt, and
calls `.compile()`. `readOttoGraphState` pays the same cost just to read state
for a server-rendered checklist.

The cause is that tools close over `ctx`, so the graph cannot be a module
singleton. LangGraph 1.4.9 solves exactly this with **runtime context**:
`StateGraph` accepts a context schema, nodes receive a `Runtime` with
`runtime.context`, and the value is supplied per invocation via
`config.context`.

**Fix (medium effort, real payoff for Otto's state reads):**

```ts
// tools receive ctx from the runtime instead of a closure
const graph = new StateGraph(ToolLoopState, { context: AgentContextSchema })
  .addNode("model", modelNode)
  ...
  .compile({ checkpointer });          // ← compiled ONCE at module scope

await graph.streamEvents(input, { version: "v2", configurable: { thread_id }, context: ctx });
```

This is a non-trivial refactor of four tool registries. Sequence it **after**
[§7](07-observability-langfuse.md) — tracing will tell you whether graph
construction is actually material against model latency, and it may well not be.
Do it sooner if `readOttoGraphState` shows up in server-render timings.

---

## 6.8 No retry or timeout policy on nodes

**Severity: P3**

The provider model classes retry transient HTTP failures themselves (the
`@langchain/google-genai` defaults document `maxRetries: 2`), so a flaky 503 is
mostly covered. What is **not** covered:

- `verify` and `plan` in Otto do live Mongo reads (`isMilestoneComplete`,
  `completedMilestones`). A replica-set blip fails the whole turn.
- Checkpointer writes have no retry.
- No node has a timeout, so a hung tool burns the full 300 s turn budget before
  the client sees anything.

LangGraph 1.4.9 supports per-node `retryPolicy` and `cachePolicy`, graph-wide
`setNodeDefaults`, and `TimeoutPolicy`:

```ts
.addNode("verify", verifyNode, {
  retryPolicy: { maxAttempts: 3, initialInterval: 200, backoffFactor: 2 },
})
```

Cheap to add for the DB-reading nodes. Note that adding a retry policy to the
**model** node would double-charge tokens on a partial failure — leave that to
the provider's own retry.

---

## 6.9 The text buffer discards interleaved prose

**Severity: P3 · Known trade-off, document it**

```ts
if (Array.isArray(output?.tool_calls) && output.tool_calls.length > 0) {
  content = "";   // drop the "let me look that up…" preamble
}
```

Correct for the common case. But a model that legitimately emits a paragraph of
analysis *and then* a tool call loses the paragraph — permanently, since it is
never persisted. It also means the user watched tokens stream in and then
disappear.

Anthropic with extended thinking and Gemini both do this occasionally.

**Fix (low risk):** keep the prose in a separate buffer and, if the final answer
turns out empty, fall back to it — rather than discarding unconditionally. Or
emit a `token`-clearing SSE frame so the client visibly resets instead of
appearing to lose text.

---

## 6.10 `streamEvents` v2 is doing more work than we need

**Severity: P3 · Optional**

`streamEvents` v2 materializes an event for **every runnable in the tree** and
we consume five event types. LangGraph 1.4.9 supports
`graph.stream(input, { streamMode: ["messages", "updates", "custom"] })`, which
delivers exactly: token chunks with node metadata, per-node state patches, and a
custom channel — the three things `runChatTurn` actually wants — without
constructing the rest.

This would also naturally absorb [§6.4](#64-side-channel-collectors-vs-graph-state)'s
`uiCalls` into the `custom` channel.

**Do not do this before Langfuse.** `streamEvents` and the callback system are
the same machinery Langfuse hooks into; changing both at once makes the first
tracing bug unattributable. Revisit after §7 is stable.

---

## 6.11 There is no agent evaluation harness

**Severity: P2 · Process**

`evals/` contains one file: `retrieval-baseline-2026-08-08.json`. The retrieval
layer has a real eval (`npm run ai:eval`, hit@k / MRR against canonical
questions). The **agents have nothing**.

Concretely, we cannot answer:

- Did the `clara-p3` prompt change improve tool ordering, or just move the
  failures?
- How often does the finalize path fire? (It is a quality signal — every
  finalize is a turn where the model ran out of budget mid-investigation.)
- What fraction of turns hit the iteration cap?
- Did switching `dora` from one model to another change fill accuracy?

`npm run ai:agent:smoke` is a one-prompt liveness check, not an eval.

**Fix.** This is the natural second phase of
[§7](07-observability-langfuse.md): Langfuse Datasets give a versioned set of
tender/document/onboarding scenarios, Langfuse Experiments run a graph over
them, and scores (rule-based first — "did it cite a real file?", "did it hit the
cap?", "did it finalize?" — LLM-as-judge later) make prompt and model changes
measurable. See [§7.8](07-observability-langfuse.md#78-phase-3--datasets-and-evaluation).

---

## 6.12 Smaller items

| # | Item | Fix |
|---|---|---|
| a | `getClaraCheckpointer` is shared by all four agents | rename `getAgentCheckpointer`, keep an alias for a release |
| b | `CLARA_GRAPH_VERSION = "clara-chat-v1"` is stamped on threads but never read for migration | either read it (refuse/upgrade old graphVersions) or drop it |
| c | Prompt versions (`clara-p3`, `dora-p2`, `dora-sheet-p3`) are constants, not attached to any output — and **Otto has none at all** | add `OTTO_SYSTEM_PROMPT_VERSION`; attach all of them to `chat_messages.metrics` and to the Langfuse trace so A/B becomes possible |
| d | `resultCount` is `null` unless a tool returns a JSON array | fine for UI, do not build metrics on it |
| e | `content = ""` on error when `content.length === 0` is a no-op | delete the branch |
| f | Dora's `edit-*.ts` and the fill pipelines call models with zero shared instrumentation | wrap in `observe()` once §7 lands ([§7.6](07-observability-langfuse.md#76-phase-2--instrumenting-lane-a-and-the-non-graph-call-sites)) |
| g | `TURN_TIMEOUT_MS` (300 s) is a constant, not an env knob | move to `aiEnv()` so it can be tuned per environment |

---

## 6.13 Suggested sequence

```
DONE       1. recursionLimit + a test that fails when a cap outgrows it        §6.1
           5. Error taxonomy (+ content_filtered, too_long, loop_exhausted)    §6.5
           7. Token-budget trimming to replace the message-count window        §6.3

Now        2. MongoDBSaver ttl + setup(); fix the stale index comment          §6.2
           3. deleteThread helper; drop the three hand-rolled deletions        §6.6

Next       4. Langfuse phase 1: tracing on all four agents                     §7.4–7.5
           6. Langfuse phase 2: lane A + the non-graph Dora call sites         §7.6
           8. Langfuse phase 3: datasets, experiments, scores                  §7.8
           9. RetryPolicy on DB-reading nodes                                  §6.8

Later      10. tenderRefs into graph state (when replay/subgraphs are needed)  §6.4
           11. Runtime context → compile graphs once                           §6.7
           12. streamEvents → streamMode                                       §6.10
```

Items 1, 5 and 7 came forward out of order because the Azure migration forced
or unlocked them: the error taxonomy because the old classifier regex-matched
Gemini's wording and would have mislabelled every Azure failure, and the
trimming because a 30-message window against a 1.1M-token context throws away
almost the whole conversation for no reason.

The correlation id from item 5 is still outstanding — it was scoped to arrive
with tracing, and that argument still holds. Everything after item 4 remains
easier to justify and easier to verify once traces exist.
