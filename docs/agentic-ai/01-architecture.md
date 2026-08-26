# 1. Architecture

## 1.1 Two lanes, on purpose

Every LLM call in this codebase goes down exactly one of two lanes. Knowing
which lane a piece of code is on tells you what it can do, how it fails, and —
critically for [section 7](07-observability-langfuse.md) — how it must be
instrumented.

```
                        AI_MODEL_ROLES  (one JSON env var)
                          role → "provider:model"
                                    │
              ┌─────────────────────┴─────────────────────┐
              ▼                                           ▼
   LANE A — the gateway                        LANE B — LangChain / LangGraph
   lib/ai/gateway/                             lib/ai/agent/, dora/, otto/
   raw fetch, no SDK                           BaseChatModel subclasses
              │                                           │
   embed()  generateStructured()                bindTools / invoke / stream
              │                                           │
   ┌──────────┴───────────┐                    ┌──────────┴──────────┐
   │ embedding/           │                    │ StateGraph          │
   │ chunking→classify    │                    │  + ToolNode         │
   │ extraction/          │                    │  + MongoDBSaver     │
   │ overview/  fit/      │                    │  + streamEvents v2  │
   │ match/ (judge, cpv)  │                    │                     │
   │ retrieval/ (rerank)  │                    │ Clara Dora Otto     │
   └──────────────────────┘                    └─────────────────────┘
   batch, idempotent, ledgered                 interactive, streamed,
   runs in BullMQ workers                      checkpointed, per-request
```

### Lane A — the model gateway (`lib/ai/gateway/`)

A 60-line role-routing façade over provider adapters. Today one adapter exists:
[`GeminiProvider`](../../lib/ai/gateway/providers/gemini.ts), written against
the raw REST API (`:batchEmbedContents`, `:generateContent`) with no SDK —
deliberately, to match the pre-existing integration style and to keep the
retry/backoff/rate-limit semantics visible in our own code.

```ts
// lib/ai/gateway/index.ts
class RoleRoutingGateway implements ModelGateway {
  async embed(request: EmbedRequest) {
    const ref = resolveRole("embedding");
    return getProvider(ref.provider).embed(ref.model, request);
  }
  async generateStructured<T>(request: GenerateStructuredRequest<T>) {
    const ref = resolveRole(request.role);
    return getProvider(ref.provider).generateStructured(ref.model, request);
  }
}
```

Adding a provider is one adapter class + one registry entry + an
`AI_MODEL_ROLES` change. Call sites never learn the provider name.

**Who is on lane A** (17 call sites):

| Module | Call |
|---|---|
| `embedding/chunk-embedder.ts`, `embedding/notice-indexer.ts` | `embed` |
| `retrieval/vector.ts`, `retrieval/hybrid.ts` | `embed` (query side) |
| `retrieval/rerank.ts` | `generateStructured` (LLM reranker slot) |
| `classification/llm-classifier.ts` | `generateStructured` |
| `extraction/engine.ts`, `extraction/extractor.ts` | `generateStructured` |
| `overview/service.ts` | `generateStructured` (bilingual dossier) |
| `fit/service.ts` | `generateStructured` |
| `match/judge.ts`, `match/cpv-derive.ts`, `match/company-profile.ts` | `generateStructured`, `embed` |

Everything on lane A is **batch, idempotent and ledgered**: work is keyed in
`ai_index_state`, replays are no-ops via content hashes, and failures land in a
queue with retry classes. Nothing on lane A streams and nothing on lane A has
conversational memory.

### Lane B — LangChain chat models + LangGraph (`lib/ai/agent/`, `dora/`, `otto/`)

Everything conversational. The reason to bring LangChain in at all is stated in
the source itself:

> Unlike the deterministic pipelines (which stay on the raw-fetch gateway),
> these use LangChain's native model classes — tool calling, token streaming
> and LangGraph integration come from the library.
> — [`lib/ai/agent/model.ts`](../../lib/ai/agent/model.ts)

Concretely, lane B buys us four things we would otherwise hand-write per
provider:

1. **Tool calling normalization.** `model.bindTools(tools)` produces the
   provider-native function-declaration format from one zod schema, and the
   response is normalized to `message.tool_calls` regardless of whether Gemini
   returned `functionCall` parts or OpenAI returned `tool_calls`.
2. **Token streaming with callbacks.** `streamEvents` gives per-token deltas,
   tool start/end with run ids, and node-level state updates from one iterator.
3. **Multimodal message parts.** One `MessageContentComplex[]` shape for text,
   base64 images and inline PDFs across three providers.
4. **LangGraph.** Durable, resumable state machines with a Mongo checkpointer —
   which is what makes "refresh the page mid-onboarding and resume" possible.

Lane B also has ~15 non-graph call sites — places that want a LangChain chat
model for its provider normalization but do *not* want a state machine:
`report/service.ts`, `verdict/service.ts`, `dora/brief.ts`,
`dora/edit-stream-turn.ts`, `dora/spreadsheet/edit.ts`, `dora/fill/analyze.ts`,
`dora/fill/pdf/analyze-pdf.ts`, `dora/fill/gaeb/analyze-gaeb.ts`,
`dora/fill/gaeb/web-prices.ts`, `dora-gateway/edit-v2.ts`. These call
`getChatModel({ role })` and then `.invoke()` / `.stream()` /
`.withStructuredOutput()` directly.

### Why not one lane?

The question comes up every time someone adds a pipeline. The current split is
defensible and should be kept, with one caveat:

- Lane A's contract is **structured output or throw**, with our own retry,
  rate-limit typing (`RateLimitError`) and MRL vector normalization. Rewriting
  that on LangChain would mean re-deriving `l2Normalize`, batch sizing and
  `retry-after` handling through an abstraction that does not model them.
- Lane B's contract is **a conversation with tools**. Hand-writing that across
  three providers is exactly the work LangChain already did.

**Caveat:** the split is also the single biggest obstacle to end-to-end
observability, because lane A emits no LangChain callbacks at all. See
[§7.6](07-observability-langfuse.md#76-phase-2--instrumenting-lane-a-and-the-non-graph-call-sites).

## 1.2 The model-role registry

The one thing both lanes share. `AI_MODEL_ROLES` is a JSON env var mapping a
**role** to `"provider:model"`; call sites only ever name roles.

```jsonc
// AI_MODEL_ROLES — every generation role on one Azure deployment
{
  "embedding":     "gemini:gemini-embedding-001",   // ← NOT azure; see below
  "extraction":    "azure:gpt-5.6-luna",
  "reasoning":     "azure:gpt-5.6-luna",
  "agent":         "azure:gpt-5.6-luna",
  "report":        "azure:gpt-5.6-luna",
  "match":         "azure:gpt-5.6-luna",
  "dora":          "azure:gpt-5.6-luna",
  "dora_fast":     "azure:gpt-5.6-luna",
  "dora_fill":     "azure:gpt-5.6-luna",
  "dora_pdf_fill": "azure:gpt-5.6-luna",
  "dora_gaeb_fill":"azure:gpt-5.6-luna",
  "dora_gaeb_web": "azure:gpt-5.6-luna",
  "otto":          "azure:gpt-5.6-luna",
  "fill_agent":    "azure:gpt-5.6-luna",
  "fill_agent_plan":     "azure:gpt-5.6-luna",
  "fill_agent_critique": "azure:gpt-5.6-luna",
  "fill_agent_repair":   "azure:gpt-5.6-luna"
}
```

The three `fill_agent_*` roles are the fill loop's cost tiers (plan → sol,
critique → terra, repair → luna once those deployments exist); each falls back
to `fill_agent` until then. `AI_FILL_AGENT_FORCE_TIER` pins all four to one
tier; `npm run ai:fill:roles` prints the resolved routing without spending
tokens.

Defaults and per-role env shortcuts live in
[`lib/ai/config/env.ts`](../../lib/ai/config/env.ts) (`defaultModelRoles()`).

**Note what a role names.** The ref carries the MODEL id, never the deployment
— the deployment comes from `AZURE_OPENAI_DEPLOYMENT` or `AI_AZURE_DEPLOYMENTS`
and is swapped in by the transport. That split is load-bearing twice over:
LangChain decides `max_completion_tokens` vs `max_tokens` from the model
string (and `max_tokens` is a hard 400 on this model), and the model id is what
gets stamped on every cached extraction and report — so renaming a deployment
must not invalidate stored artifacts.

Four design rules encoded here, worth keeping:

1. **A role per product surface, not per model tier.** All fourteen resolve to
   one deployment today, and that is exactly why the roles still matter: any
   one of them can be moved without touching the others.
2. **Differentiation moved from the model to the effort.** The roles used to
   differ by model tier; now they differ by reasoning effort and output budget
   (see [`08-operations.md`](08-operations.md)). One deployment, fourteen
   operating points.
3. **The fill roles no longer need separate pins.** They were pinned so a
   chat-model upgrade could not silently change a legal document or a price;
   with one deployment that isolation comes from the effort table instead. The
   shortcuts still exist — pin them again when there is a second deployment.
4. **`embedding` is the one role configuration cannot move.** It stays on
   Gemini because luna-dev is a chat deployment and changing the embedding
   model means re-embedding every stored vector and rebuilding both Atlas
   vector indexes. `AzureOpenAIProvider.embed()` throws with that explanation
   rather than letting a one-line edit start a silent corpus rebuild.

## 1.3 What an "agent" is in this codebase

An agent = **a compiled LangGraph state machine + a tool registry + a per-turn
system prompt + a run context**, driven by the shared turn runner.

```
AgentRunContext ──┐
                  ├──► buildXGraph(ctx) ──► CompiledStateGraph
tools(ctx) ───────┤                              │
prompt(ctx) ──────┘                              │
                                                 ▼
POST /api/.../chat ──► streamChatTurnResponse ──► runChatTurn ──► streamEvents
                                                                     │
                                       SSE: ready|token|tool|tenders|ui|state|message|error
```

The **run context** (`AgentRunContext`, `DoraRunContext`, `OttoRunContext`) is
built server-side per request and carries: `tenantId`, `userId`, `locale`, the
tender/document scope, and three mutable collectors — `citations`,
`tenderRefs`, `uiCalls` — that tools push into and the turn runner drains.
Context never enters graph state and is never checkpointed.

Four agents exist:

| Agent | Route | Graph | Role | Thread key |
|---|---|---|---|---|
| **Clara** — tender chat | `POST /api/tenders/[id]/chat`, `POST /api/chat/threads/[id]` | `buildClaraGraph` | `agent` | `clara:{tenant}:{tender}` / `clarag:{threadId}` |
| **Dora** — document assistant | `POST /api/workspace-documents/[id]/dora/chat`, `POST /api/dora-gateway/chat/[id]` | `buildDoraGraph` | `dora` | `dora:…` |
| **Dora-Spreadsheet** | `POST /api/dora-gateway/chat/[id]` (spreadsheet branch) | `buildDoraSpreadsheetGraph` | `dora` | `dora:…` |
| **Otto** — onboarding | `POST /api/otto/chat` | `buildOttoGraph` | `otto` | `otto:{tenant}:{user}` |

Naming: Clara and Dora are the shipped product names; see the
[glossary](../GLOSSARY.md) and `BAU_AI_AGENTIC_TENDER_ROADMAP.md` for the
roadmap names, which deliberately differ.

## 1.4 Where the code lives

```
lib/ai/
├── config/env.ts             lazy zod env; AI_MODEL_ROLES; every knob
├── gateway/                  LANE A — provider-agnostic embed/generateStructured
│   ├── index.ts              role-routing façade
│   ├── config.ts             resolveRole("provider:model")
│   └── providers/gemini.ts   raw-fetch adapter, retry/backoff, l2Normalize
├── agent/                    LANE B core + Clara
│   ├── model.ts              getChatModel({role}) → BaseChatModel (3 providers)
│   ├── tool-loop.ts          ★ the shared capped tool loop (nodes + graph)
│   ├── checkpointer.ts       MongoDBSaver singleton
│   ├── graph.ts              Clara = tool loop + Clara's model/tools/prompt
│   ├── tools.ts              Clara's 20-tool registry
│   ├── prompt.ts             per-turn system prompt
│   ├── service.ts            ★ runChatTurn — streamEvents → callbacks → Mongo
│   ├── sse-turn.ts           ★ the one SSE-over-POST implementation
│   ├── threads.ts            thread-key derivation, checkpoint deletion
│   ├── attachments.ts        multimodal parts, media_ref indirection
│   ├── content.ts            textFromContent (thinking-model safe)
│   ├── context.ts            AgentRunContext
│   ├── citations.ts / tender-refs.ts / ui-calls.ts   per-turn collectors
│   └── testing.ts            FakeToolCallingChatModel
├── dora/                     document assistant
│   ├── graph.ts              tool loop + Dora's model/tools/prompt
│   ├── tools.ts              13 tools (document + tender + company)
│   ├── spreadsheet/graph.ts  tool loop, spreadsheet tools/prompt
│   ├── edit-*.ts             streaming single-point edits (no graph)
│   ├── brief.ts              document brief (no graph)
│   └── fill/                 Word / PDF / GAEB fill pipelines (no graph)
└── otto/                     onboarding
    ├── state.ts              OttoState = toolLoopStateSpec + onboarding channels
    ├── graph.ts              profile → plan → guide ⇄ tools → verify
    ├── tools.ts              6 navigation/tour tools
    └── service.ts            reconciles checkpoint ↔ AccountProfile mirror
```

The `★` files are the four you must read to understand lane B. Everything else
is an agent-specific specialization of them.

## 1.5 Runtime placement

| Where | What runs there |
|---|---|
| Next.js route handler (Node runtime) | All four agents. A turn is an in-flight HTTP request holding an SSE stream open, up to `TURN_TIMEOUT_MS` = 300 s. |
| BullMQ workers (`npm run worker:ai`, `worker:documents`) | Lane A only — embedding, chunking, classification, extraction, matching. |
| Inline in a route | `overview/`, `fit/`, `verdict/`, `report/` (report also has a job path), Dora fill for small documents. |
| Queue worker | GAEB fill above `AI_GAEB_FILL_INLINE_MAX_ITEMS` (60) positions. |

**No agent runs in a worker.** That matters for [§7](07-observability-langfuse.md):
tracing must be initialized in the Next.js server process
(`instrumentation.ts`) *and* separately in each worker entry point, because the
worker processes are plain Node scripts (`node --experimental-strip-types
workers/*.mts`), not Next.js.
