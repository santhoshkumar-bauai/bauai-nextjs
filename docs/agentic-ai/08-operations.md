# 8. Operations

Every knob, every runbook, every "how do I…" for the agentic layer.

## 8.1 Environment reference

All agent-relevant variables. Full schema in
[`lib/ai/config/env.ts`](../../lib/ai/config/env.ts) — validated lazily by
`aiEnv()`, so importing AI code never crashes a build or an unrelated route.

### Model routing

| Var | Default | Effect |
|---|---|---|
| `AI_MODEL_ROLES` | see below | JSON `{role: "provider:model"}`. Merged **over** the defaults, so partial overrides work. |
| `GEMINI_API_KEY` | — | required by every Gemini path; asserted at call time, not import time |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | — | required only if a role resolves to that provider |
| `GEMINI_MODEL` | `gemini-2.5-flash-lite` | legacy shortcut for the `extraction` + `reasoning` roles only |
| `AI_REPORT_MODEL` | falls back to `agent` | the top-tier fallback for `report`, `match`, `dora`, `otto` |
| `AI_MATCH_MODEL` · `AI_DORA_MODEL` · `AI_OTTO_MODEL` | chain via `AI_REPORT_MODEL` | per-surface pins |
| `AI_DORA_FAST_MODEL` | chains via `AI_DORA_MODEL` | streamed single-point edits; latency-optimized |
| `AI_DORA_FILL_MODEL` | `gemini:gemini-3.7-flash` | **pinned**, not chained — protects generated documents |
| `AI_DORA_PDF_FILL_MODEL` | chains via `AI_DORA_FILL_MODEL` | needs a PDF-capable model |
| `AI_DORA_GAEB_FILL_MODEL` | chains via `AI_DORA_FILL_MODEL` | **pinned** — protects priced offers |
| `AI_DORA_GAEB_WEB_MODEL` | chains via `AI_DORA_GAEB_FILL_MODEL` | needs a provider with native web search |

> Roles that chain through `AI_REPORT_MODEL` exist so an unconfigured
> deployment still runs. Roles that are **pinned** exist so a chat-model upgrade
> cannot silently change a legal document or a price. Do not "simplify" a pinned
> role into the chain.

### Agent loop

| Var | Default | Effect |
|---|---|---|
| `AI_AGENT_MAX_ITERATIONS` | `8` | tool-loop cap for tender chat, Dora, Otto. **⚠ Raising this to 10 exceeds LangGraph's default recursion limit for Otto** — see [§6.1](06-review.md#61-the-recursion-limit-is-two-supersteps-away) |
| `AI_AGENT_GLOBAL_MAX_ITERATIONS` | `10` | global (non-tender) Clara chats — longer find → drill-in chains |
| `AI_AGENT_MAX_OUTPUT_TOKENS` | `8192` | thinking models spend reasoning from the same budget; 2048 produced empty answers |
| `AI_AGENT_HISTORY_MAX_MESSAGES` | `30` | model-context window. **UI history is unlimited** — this only affects what the model sees |
| `AI_AGENT_REASONING` | unset | `none` \| `low` \| `medium` \| `high`; unset = provider default |

### Report

| Var | Default |
|---|---|
| `AI_REPORT_MAX_OUTPUT_TOKENS` | `32768` |
| `AI_REPORT_REASONING` | `high` |
| `AI_REPORT_MAX_TENDER_CHUNKS` | `40` |
| `AI_REPORT_MAX_COMPANY_CHUNKS` | `16` |

### Matching

| Var | Default | Note |
|---|---|---|
| `AI_MATCH_ENABLED` | `true` | |
| `AI_MATCH_RANK_CAP` | `200` | rows served **and** judging depth — the main cost lever |
| `AI_MATCH_POOL_CAP` | `400` | distinct tenders kept after fusion |
| `AI_MATCH_CANDIDATES_PER_FACET` | `250` | `$vectorSearch` limit per facet |
| `AI_MATCH_NUM_CANDIDATES` | `4000` | generous: deadline/isVisible are post-filters |
| `AI_MATCH_MAX_FACETS` | `24` | |
| `AI_MATCH_JUDGE_BATCH` | `10` | tenders per judge call |
| `AI_MATCH_JUDGE_CONCURRENCY` | `3` | parallel judge calls |
| `AI_MATCH_STALE_HOURS` | `6` | refresh sweep threshold |
| `AI_MATCH_LEXICAL` | `false` | BM25 arm |
| `AI_MATCH_W_RULE_ARM` | `0.6` | fusion weight — **rollback lever, no deploy needed** |
| `AI_MATCH_W_TEXT_ARM` | `0.9` | `AI_MATCH_W_TEXT_ARM=0 AI_MATCH_W_RULE_ARM=1.2` restores pre-text-arm ordering exactly |

### Dora fill / GAEB

| Var | Default | Note |
|---|---|---|
| `AI_GAEB_FILL_BATCH_SIZE` | `20` | positions per classify/price call (max 50) |
| `AI_GAEB_FILL_BATCH_CONCURRENCY` | `2` | max 4 |
| `AI_GAEB_FILL_MAX_POSITIONS` | `3000` | hard guard — larger runs rejected up front |
| `AI_GAEB_FILL_INLINE_MAX_ITEMS` | `60` | above this the run must go through the queue worker |
| `AI_GAEB_FILL_MAX_OUTPUT_TOKENS` | `16384` | |
| `AI_GAEB_WEB_PRICING_ENABLED` | `true` | |
| `AI_GAEB_WEB_PRICING_MAX_LOOKUPS` | `40` | max 200 |
| `GAEB_PARSER_VERSION` | `v1` | **cache identity** — bumping re-parses on next open |

### Retrieval / extraction / embedding

| Var | Default | Note |
|---|---|---|
| `EMBEDDING_MODEL` | `gemini-embedding-001` | stamped onto every vector |
| `EMBEDDING_VERSION` | `2026-08` | **bump to re-embed** via the sweep |
| `EMBEDDING_DIMENSIONS` | `1536` | MRL truncation target; vectors L2-normalized after |
| `EMBEDDING_BATCH_SIZE` | `64` | Gemini caps at 100 |
| `EMBEDDING_RPM` | `100` | BullMQ limiter |
| `AI_USE_RANK_FUSION` | `false` | |
| `AI_RERANKER` | `noop` | `noop` \| `llm` |
| `AI_EXTRACTION_MAX_CHUNKS` | `16` | |
| `AI_EXTRACTION_MAX_DOC_CHARS` | `150000` | |
| `AI_EXTRACTION_RPM` / `_CONCURRENCY` | `30` / `2` | |
| `CHUNK_TARGET_TOKENS` / `CHUNK_MAX_TOKENS` | `500` / `1200` | |
| `CHUNKER_VERSION` / `CLASSIFIER_VERSION` | `v1` | cache identity |

### Infrastructure

| Var | Default |
|---|---|
| `AI_REDIS_PREFIX` | `{bauai:ai}` — hash-tagged so all BullMQ keys land on one cluster slot |
| `AI_WORKER_CONCURRENCY` | `4` |

### Proposed (§7)

`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`,
`LANGFUSE_TRACING_ENVIRONMENT`, `LANGFUSE_RELEASE`, `LANGFUSE_SAMPLE_RATE`,
`LANGFUSE_DEBUG`.

### Hard-coded, not env — candidates for promotion

| Constant | Value | File |
|---|---|---|
| `TURN_TIMEOUT_MS` | 300 000 ms | `agent/sse-turn.ts` |
| `HEARTBEAT_INTERVAL_MS` | 25 000 ms | `agent/sse-turn.ts` |
| `recursionLimit` | **unset** → 25 | nowhere — see [§6.1](06-review.md#61-the-recursion-limit-is-two-supersteps-away) |
| Tool caps (`TEXT_CAP` 1 500 … `FILE_READ_CAP` 20 000) | — | `agent/tools.ts` |
| `ANTHROPIC_THINKING_BUDGET` | 2 048 / 6 144 / 12 288 | `agent/model.ts` |

## 8.2 Commands

```bash
# Bootstrap indexes + Atlas search indexes (idempotent)
npm run ai:bootstrap
```
```bash
# One prompt through the chat-model factory — liveness, not an eval
npm run ai:agent:smoke
```
```bash
# Retrieval eval: hit@k / MRR against the canonical question set
npm run ai:eval
```
```bash
# Wipe ALL chat/agent state (threads, messages, attachments+S3, verdicts, checkpoints)
npm run ai:reset:chat -- --dry-run
```
```bash
npm run ai:reset:chat -- --yes
```
```bash
# Workers
npm run worker:ai
```
```bash
npm run worker:documents
```
```bash
# Tests
npm run test
```
```bash
npm run typecheck
```

## 8.3 Runbooks

### R1 — Changing the system prompt

1. Edit the builder (`agent/prompt.ts`, `dora/prompt.ts`, `otto/prompt.ts`).
2. **Bump the version constant**: `CLARA_SYSTEM_PROMPT_VERSION` (`clara-p3`),
   `DORA_SYSTEM_PROMPT_VERSION` (`dora-p2`), `DORA_SPREADSHEET_PROMPT_VERSION`
   (`dora-sheet-p3`). *Otto has none* — add one.
3. If you added or removed a tool, update the **"Which tool, in what order"**
   block. A tool with only a description will be mis-ordered.
4. `npm run test` — `prompt.test.ts` pins structural invariants.
5. **No wipe needed.** The prompt is injected fresh on every model call and
   never checkpointed, so the change applies to conversations already in flight.

### R2 — Adding a tool

1. Add it to `buildXTools(ctx)` with a zod schema and a **capped** return.
2. Add `Chat.tool.<name>` to **both** message catalogs (`messages/en.json`,
   `messages/de.json`) — `tools.test.ts` fails the build otherwise.
3. Place it in the prompt's tool-order block.
4. Never accept a tenant id as a tool input; re-validate any tender id through
   `getVisibleTender`.
5. Re-check the iteration cap: a new tool that adds a hop may mean turns now hit
   `finalize`. Watch for it — and once [§7](07-observability-langfuse.md) is
   live, watch the `LangGraph:finalize` span rate.

### R3 — Changing a model

1. Edit `AI_MODEL_ROLES` (or the per-role shortcut env var). **No code change.**
2. Restart. Roles resolve lazily but `aiEnv()` caches for the process lifetime.
3. If it is a Gemini 3.6+ model, confirm `geminiUsesFixedSampling` matches it —
   a legacy `temperature` in `generationConfig` is a 400, not a warning.
4. If it is a new provider, `requireKey` will name the missing env var in its
   error. Run `npm run ai:agent:smoke` before anything else.
5. **Never** repoint a pinned fill role casually. Generated documents and priced
   offers will change.

### R4 — Changing the graph shape or thread-key format

This is the destructive one.

1. Bump `CLARA_GRAPH_VERSION` (and the Dora/Otto equivalents).
2. `npm run ai:reset:chat -- --dry-run`, read the output.
3. `npm run ai:reset:chat -- --yes`.

Wipes threads, messages, attachments (and their S3 objects), verdicts, and both
checkpoint collections. Leaves chunks, embeddings, extractions,
classifications, overviews and fit recommendations alone — re-deriving those
costs hours of model spend.

The script guards against wiping a shared cluster:
`--i-know-this-is-remote` is required for a non-localhost URI, and it redacts
the password before the URI reaches any log.

> The thread-key formats are **frozen**. `threads.test.ts` in all three agents
> pins the exact string. Changing one without this wipe orphans every ongoing
> conversation — the symptom is "Clara forgot everything", silently.

### R5 — "The agent replies but nothing streams"

Almost always: **a node dropped `config`**.

```bash
grep -rn "model.invoke(\|boundModel.invoke(" lib/ai --include=*.ts
```

Every call must pass `config` as the second argument. Without it the callback
manager is not propagated, `streamEvents` sees no token events — and, once §7
lands, that model call also vanishes from the trace.

### R6 — "Every reply is blank"

Order of suspicion:

1. **Malformed history** → Gemini returns empty content. Check that the model
   call went through `contextWindow()` (`windowFromUserTurn` +
   `sanitizeToolPairs`). This is what broke Otto's guide node once.
2. **Output budget exhausted by reasoning.** Raise
   `AI_AGENT_MAX_OUTPUT_TOKENS`, or lower `AI_AGENT_REASONING`.
3. **`instanceof AIMessage` somewhere.** Under `streamEvents` the model yields
   `AIMessageChunk`, which is not an `AIMessage`. Use `getType() === "ai"`.
4. **Reading `.content` directly.** Thinking models return array content; use
   `textFromContent`.

If it is genuinely a model that ran out of things to say, the finalize path
should already have caught it — `routeAfterModel` routes empty answers to
`finalize`, not to `END`.

### R7 — "Onboarding is broken" / `error: failed` on every Otto turn

Check whether `AI_AGENT_MAX_ITERATIONS` was raised. Otto's worst path is ~22
supersteps at the default of 8; LangGraph's unset recursion limit is 25. At 10
iterations Otto exceeds it on every turn and `GraphRecursionError` surfaces as
`"failed"`. See [§6.1](06-review.md#61-the-recursion-limit-is-two-supersteps-away).

Immediate mitigation: put `AI_AGENT_MAX_ITERATIONS` back to 8. Real fix: set
`recursionLimit` explicitly.

### R8 — Clearing one conversation

```ts
await deleteThread(thread);   // lib/ai/agent/threads.ts
```

Tender threads keep the thread document and reset the counters (today's "clear"
semantics); global threads are removed entirely. Both delete the checkpoints.
Do not delete `chat_messages` without deleting the checkpoints — the UI would go
blank while the model still remembered everything.

### R9 — Cost spike

Today: check the provider console, then reason backwards from `AI_MATCH_*`
(highest volume), report generation (largest single call), and GAEB fill
(largest batch count). Cross-reference `chat_messages.metrics` for chat volume.

There is no way to attribute cost to a tenant or a feature. That is
[§7.7](07-observability-langfuse.md#77-what-the-traces-make-answerable), and it
is the reason this doc exists.

Fastest blunt levers, in order:
`AI_MATCH_ENABLED=false` → `AI_MATCH_RANK_CAP` down →
`AI_GAEB_WEB_PRICING_ENABLED=false` → `AI_REPORT_REASONING=low`.

## 8.4 Testing

22 test files cover the agent layer.

| File | Covers |
|---|---|
| `agent/graph.test.ts` | loop routing, finalize, `sanitizeToolPairs`, `windowFromUserTurn` |
| `agent/service.test.ts` | `streamEvents` → callbacks → persistence |
| `agent/tools.test.ts` | tool registry **and i18n label parity** |
| `agent/prompt.test.ts` | prompt structure invariants |
| `agent/threads.test.ts` | **the frozen thread-key format** |
| `agent/attachments.test.ts` | `media_ref` round-trip |
| `agent/model.test.ts` | role resolution, provider option mapping |
| `agent/{tender-refs,ui-calls,workspace,report-view}.test.ts` | collectors and data layer |
| `dora/graph`-adjacent, `dora/tools.test.ts`, `dora/prompt.test.ts`, `dora/threads.test.ts` | Dora |
| `dora/chat.integration.test.ts`, `dora/brief.integration.test.ts` | Dora end-to-end |
| `otto/graph.test.ts` | the full profile → plan → guide → verify machine |
| `otto/prompt.test.ts`, `otto/threads.test.ts` | Otto |

### The graph-test pattern

```ts
vi.mock("./tools.ts",       () => ({ buildClaraTools: () => [ /* fake tool */ ] }));
vi.mock("./checkpointer.ts", async () => {
  const { MemorySaver } = await import("@langchain/langgraph");
  const saver = new MemorySaver();
  return { getClaraCheckpointer: async () => saver };
});
vi.mock("@langchain/langgraph/prebuilt", async () => ({ ToolNode: FakeToolNode }));

setAgentModelForTests(new FakeToolCallingChatModel([ /* scripted AIMessages */ ]));
```

`MemorySaver` for the checkpointer, a scripted `FakeToolCallingChatModel` for
the model, a passthrough `ToolNode`. No network, no Mongo, deterministic.

### Missing coverage — known gaps

- No test asserts the graph stays under the recursion limit
  ([§6.1](06-review.md#61-the-recursion-limit-is-two-supersteps-away)).
- No agent-level quality eval
  ([§6.11](06-review.md#611-there-is-no-agent-evaluation-harness)).
- No test that a turn survives an unreachable observability backend — add it
  with §7.
- Provider portability is untested; only Gemini is exercised.

## 8.5 Collections owned by the agent layer

| Collection | Scope | Owner | Notes |
|---|---|---|---|
| `chat_threads` | tenant | `agent/threads.ts` | `threadKey`, `agent`, `graphVersion`, `kind` |
| `chat_messages` | tenant | `agent/service.ts` | `toolEvents`, `citations`, `tenderRefs`, `metrics` |
| `chat_attachments` | tenant | `agent/attachments.ts` | S3-backed; unclaimed uploads expire |
| `tender_verdicts` | tenant | `verdict/service.ts` | linked from a message via `verdictId` |
| `agent_checkpoints` | **global** | `MongoDBSaver` | isolation is the thread key, not a field |
| `agent_checkpoint_writes` | **global** | `MongoDBSaver` | |

Checkpoint collections sit **outside** the `aiCollectionNames` registry because
`MongoDBSaver` owns their schema. Their index is created by hand in
`db/indexes.ts` — see
[§6.2](06-review.md#62-checkpoints-grow-forever-and-the-read-index-is-the-wrong-shape)
for why that should change.

## 8.6 Quick decision table

| I want to… | Do this | Wipe needed? |
|---|---|---|
| change what an agent says | edit the prompt builder, bump the version | no |
| add a capability | add a tool + i18n labels + tool-order entry | no |
| change model or provider | `AI_MODEL_ROLES` | no |
| let the agent do more per turn | raise `AI_AGENT_MAX_ITERATIONS` — **check the recursion limit first** | no |
| let the agent remember more | raise `AI_AGENT_HISTORY_MAX_MESSAGES` (blunt — see [§6.3](06-review.md#63-the-effective-memory-window-is-much-shorter-than-30-messages)) | no |
| change the graph shape | edit the graph, bump `graphVersion` | **yes** |
| change a thread-key format | edit + update the pinning test | **yes** |
| re-embed the corpus | bump `EMBEDDING_VERSION`, run the sweep | no (re-derives) |
| re-parse GAEB files | bump `GAEB_PARSER_VERSION` | no (re-parses on open) |
| find out what an agent actually did | *not currently possible* — [§7](07-observability-langfuse.md) | — |
