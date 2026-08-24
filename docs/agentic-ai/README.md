# Agentic AI — the reference book

How BAU AI builds, runs, debugs and observes its LLM agents. Everything here
describes code that exists in this repo, except where a section is explicitly
marked **Proposed** (Langfuse) or **Recommendation**.

Companion docs: [`docs/AI_SUBSYSTEM.md`](../AI_SUBSYSTEM.md) (the deterministic
retrieval/extraction foundation), [`docs/GLOSSARY.md`](../GLOSSARY.md) (German
procurement terms ↔ English identifiers), [`docs/ONLYOFFICE/`](../ONLYOFFICE/)
(the document-editor surface Dora drives).

## Read in this order

| # | Doc | What it answers |
|---|---|---|
| 1 | [Architecture](01-architecture.md) | Why two lanes (raw gateway vs LangChain), where each library sits, what an "agent" is here |
| 2 | [The LangChain layer](02-langchain.md) | Models, messages, tools, structured output, streaming, multimodal, testing |
| 3 | [The LangGraph layer](03-langgraph.md) | State/annotations/reducers, the shared tool loop, checkpointing, thread keys, routing |
| 4 | [The four agents](04-agents.md) | Clara, Dora, Dora-Spreadsheet, Otto — topology, tools, prompts, state |
| 5 | [A turn, end to end](05-turn-lifecycle.md) | HTTP → SSE → `streamEvents` → persistence, abort/timeout, failure modes |
| 6 | [Implementation review](06-review.md) | What is genuinely good, what is fragile, ranked concrete improvements |
| 7 | [Observability with Langfuse](07-observability-langfuse.md) | **Proposed.** Full integration design, code, rollout, dashboards, cost control |
| 8 | [Operations](08-operations.md) | Every env knob, runbooks, resets, tests, cost levers, incident playbooks |

## One-page summary

**Two lanes.** Deterministic pipelines (embedding, extraction, classification,
matching, overview, fit) go through a hand-written provider gateway
(`lib/ai/gateway/`, raw `fetch`, no SDK). Conversational agents go through
LangChain chat models driven by LangGraph state machines (`lib/ai/agent/`,
`dora/`, `otto/`). The two lanes share one thing: the **model-role registry**,
so `AI_MODEL_ROLES` is the single place any model or provider changes.

**Four graphs, one loop.** Clara (tender chat), Dora (document assistant),
Dora-Spreadsheet, and Otto (onboarding) all compile from
[`lib/ai/agent/tool-loop.ts`](../../lib/ai/agent/tool-loop.ts) — a hand-rolled
capped tool loop with a forced-finalize path, deliberately not
`createReactAgent`. Clara, Dora and Dora-Spreadsheet use it as the whole
machine; Otto embeds its nodes inside a wider profile → plan → guide → verify
state machine.

**One checkpointer.** `MongoDBSaver` over `agent_checkpoints` /
`agent_checkpoint_writes`, keyed by a server-derived `thread_id`
(`clara:{tenant}:{tender}`, `dora:…`, `otto:…`). Clients never supply a thread
id, so cross-tenant checkpoint access is inexpressible through the API.

**One turn runner.** [`runChatTurn`](../../lib/ai/agent/service.ts) consumes
`graph.streamEvents(..., {version: "v2"})` and translates LangChain events into
SSE frames; [`streamChatTurnResponse`](../../lib/ai/agent/sse-turn.ts) is the
single SSE-over-POST implementation behind all four agents' routes.

**Observability today: none.** No Langfuse, no LangSmith, no OpenTelemetry. Per-turn
counters (`llmCalls`, `inputTokens`, `outputTokens`, `durationMs`) are written
onto each assistant `chat_messages` document, and that is the entire telemetry
surface. Section 7 is the plan to fix that.

## Version pins this book was written against

| Package | Version |
|---|---|
| `@langchain/core` | 1.2.5 |
| `@langchain/langgraph` | 1.4.9 |
| `@langchain/langgraph-checkpoint-mongodb` | 1.4.0 |
| `@langchain/google-genai` | 2.2.0 |
| `@langchain/openai` | 1.5.6 |
| `@langchain/anthropic` | 1.5.4 |
| `next` | 16.3.0 |

LangGraph 1.x moves fast. When bumping, re-check the claims in
[06-review.md](06-review.md) — several recommendations there depend on APIs
(`RetryPolicy`, `Command` from tools, `REMOVE_ALL_MESSAGES`, runtime `context`)
that arrived in 1.x and could shift again.
