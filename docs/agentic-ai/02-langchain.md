# 2. The LangChain layer

What we use from LangChain, what we deliberately do not, and the traps each
piece has already cost us.

## 2.1 The surface we actually use

| Import | Used for | Files |
|---|---|---|
| `@langchain/core/language_models/chat_models` | `BaseChatModel` type; `BaseChatModel` subclass for the test fake | `agent/model.ts`, `agent/tool-loop.ts`, `agent/testing.ts` |
| `@langchain/core/messages` | `SystemMessage`, `HumanMessage`, `AIMessage`, `ToolMessage`, `BaseMessage`, `MessageContentComplex` | 10 files |
| `@langchain/core/tools` | `tool()` factory → `StructuredToolInterface` | `agent/tools.ts`, `dora/tools.ts`, `dora/spreadsheet/tools.ts`, `otto/tools.ts` |
| `@langchain/core/runnables` | `RunnableConfig` (threaded through every node) | `agent/tool-loop.ts`, `agent/service.ts`, `otto/graph.ts` |
| `@langchain/core/tracers/log_stream` | `StreamEvent` type for the turn runner | `agent/service.ts` |
| `@langchain/core/outputs`, `.../callbacks/manager` | `ChatGenerationChunk`, `CallbackManagerForLLMRun` in the fake model | `agent/testing.ts` |
| `@langchain/google-genai` | `ChatGoogleGenerativeAI` | `agent/model.ts` (dynamic import) |
| `@langchain/openai` | `ChatOpenAI` | `agent/model.ts` (dynamic import) |
| `@langchain/anthropic` | `ChatAnthropic` | `agent/model.ts` (dynamic import) |

**Not used, deliberately:** LCEL pipe chains, `PromptTemplate` /
`ChatPromptTemplate`, output parsers, retrievers, vector stores, document
loaders, memory classes, `createReactAgent`. Prompts are plain template
functions returning strings; retrieval is our own Mongo `$vectorSearch` /
`$search` + RRF stack (see [`docs/AI_SUBSYSTEM.md`](../AI_SUBSYSTEM.md)).

That restraint is the right call and worth stating explicitly: **LangChain is
used as a provider-normalization layer, not as an application framework.**

## 2.2 The model factory

[`lib/ai/agent/model.ts`](../../lib/ai/agent/model.ts) is the only place a
chat model is constructed. One function, `getChatModel({ role, ... })`,
resolves the role through `AI_MODEL_ROLES` and returns a `BaseChatModel`.

```ts
export async function getChatModel(options: ChatModelOptions = {}): Promise<BaseChatModel> {
  if (testOverride) return testOverride;            // ← test seam, see §2.8
  const env  = aiEnv();
  const role = options.role ?? "agent";
  const ref  = resolveRole(role);                   // "gemini:gemini-3.5-flash"
  ...
  switch (ref.provider) {
    case "gemini":    { const { ChatGoogleGenerativeAI } = await import("@langchain/google-genai"); ... }
    case "openai":    { const { ChatOpenAI }             = await import("@langchain/openai");       ... }
    case "anthropic": { const { ChatAnthropic }          = await import("@langchain/anthropic");    ... }
  }
}
```

Three things here are load-bearing.

### Dynamic imports

All three provider packages are installed, but only the configured one is ever
loaded. This keeps the Next.js server bundle from pulling in three SDKs, and it
means a missing key for an unused provider is never a startup failure.

### Per-provider reasoning-effort mapping

One product-level concept (`"none" | "low" | "medium" | "high"`) mapped onto
three incompatible provider knobs:

```ts
// Gemini: thinkingConfig
effort === "none"
  ? { thinkingConfig: { thinkingBudget: 0 } }
  : { thinkingConfig: { thinkingLevel: effort.toUpperCase() } }

// OpenAI: reasoningEffort, with "none" → "minimal"
{ reasoningEffort: effort === "none" ? "minimal" : effort }

// Anthropic: an explicit token budget that must sit below maxTokens
const ANTHROPIC_THINKING_BUDGET = { low: 2_048, medium: 6_144, high: 12_288 };
{ thinking: { type: "enabled", budget_tokens: budget },
  maxTokens: budget + maxOutputTokens }
```

Leaving `effort` unset means "provider default" (dynamic thinking) — the map
never invents a value.

### Two hard-won provider quirks

Both of these are already-paid-for bugs. Do not "clean them up".

```ts
// 1. Gemini 3.6+ rejects the legacy sampling knobs with INVALID_ARGUMENT.
function geminiUsesFixedSampling(model: string): boolean {
  const match = model.replace(/^models\//, "").match(/^gemini-3\.(\d+)(?:-|$)/);
  return match !== null && Number(match[1]) >= 6;
}
...(geminiUsesFixedSampling(ref.model) ? {} : { temperature }),
```
Leaving the value `undefined` keeps it out of the serialized `generationConfig`
entirely — setting it to any number, including the model's own default, is a
400.

```ts
// 2. Anthropic extended thinking rejects a custom temperature,
//    and max_tokens must EXCEED the thinking budget.
...(budget ? {} : { temperature }),
maxTokens: budget ? budget + maxOutputTokens : maxOutputTokens,
```

### Output-token budgets

`maxOutputTokens` defaults to `AI_AGENT_MAX_OUTPUT_TOKENS` (8192) except for the
`report` role, which gets `AI_REPORT_MAX_OUTPUT_TOKENS` (32 768). 8192 for the
agent is not generosity — it is a fix:

> Generous because thinking models spend reasoning tokens from the SAME
> budget — 2048 starved gemini-3.5-flash into empty answers on complex
> multi-tool turns. — `lib/ai/config/env.ts`

## 2.3 Messages

### The content shape

Message content is either a `string` or `MessageContentComplex[]`. Thinking
models return array content with reasoning parts mixed into it, which is why
**no code in this repo reads `message.content` directly for display**. It goes
through [`textFromContent`](../../lib/ai/agent/content.ts) instead. Reading
`.content` as a string is the single most common way to end up with an empty
assistant bubble.

### The `media_ref` indirection

[`agent/attachments.ts`](../../lib/ai/agent/attachments.ts) solves a real
problem: an attached image must stay visible across the whole conversation
(so it belongs in checkpointed state) but base64 image payloads in a Mongo
checkpoint are ruinous.

The solution is a two-step:

1. The user turn is checkpointed with a tiny custom part —
   `{ type: "media_ref", ... }` — plus any extracted document text inline.
2. At **model-call time**, `resolveMediaParts(window, mediaCache)` materializes
   each `media_ref` into a real base64 part, memoized in a per-turn `Map`.

```ts
// lib/ai/agent/tool-loop.ts
const mediaCache = new Map<string, string>();

const modelNode = async (state, config) => {
  const window = await resolveMediaParts(contextWindow(state.messages), mediaCache);
  const response = await boundModel.invoke([resolvePrompt(state), ...window], config);
  return { messages: [response], iterations: state.iterations + 1 };
};
```

Checkpoints stay small; the model still sees the image on turn 12.

### Extra multimodal parts

`runChatTurn({ extraContent })` appends `MessageContentComplex[]` to the user
turn beyond what the attachments produce. This is how Dora hands the model a
**scanned PDF as a native file part** when text extraction cannot reach it
(`dora/pdf/turn-media.ts`, `dora/fill/pdf/model-input.ts`).

## 2.4 Tools

Tools are built with the `tool()` factory and a zod schema. Every agent exports
a `buildXTools(ctx): StructuredToolInterface[]` that closes over the run
context.

```ts
// lib/ai/agent/tools.ts  (shape, abridged)
const searchTenderDocuments = tool(
  async ({ tenderId, query }) => renderTenderSearch(ctx, scope, query),
  {
    name: "search_tender_documents",
    description: "…",
    schema: z.object({ tenderId: tenderIdInput, query: z.string() }),
  },
);
```

Five conventions, all enforced somewhere:

1. **Tools return strings, not objects.** Almost always `JSON.stringify(...)`
   of a small projection, or a pre-rendered markdown block. Keeps the
   `ToolMessage` content deterministic and the token cost predictable.
2. **Everything is capped.** `TEXT_CAP` 1 500, `SECTION_CAP` 2 500,
   `DESCRIPTION_CAP` 2 000, `PROFILE_CAP` 6 000, `FILE_READ_CAP` 20 000 chars,
   via a shared `cap()` helper. An uncapped tool is how one document blows a
   context window.
3. **Tool inputs never carry a tenant id.** The tenant comes from the
   server-built context. A tender id in a tool argument is re-validated per call
   through `getVisibleTender` — a forged id resolves to `TENDER_NOT_FOUND`.
4. **Every tool needs an i18n label.** `Chat.tool.<name>` must exist in both
   message catalogs; `tools.test.ts` fails the build otherwise. This is what
   makes the SSE `tool` events renderable.
5. **Side effects go to collectors, not return values.** A tool that surfaces a
   tender card calls `ctx.tenderRefs.add(...)`; a tool that wants the frontend
   to navigate calls `ctx.uiCalls.register(...)`. The turn runner drains both on
   every `on_tool_end`. (See [§6.4](06-review.md#64-side-channel-collectors-vs-graph-state)
   for the trade-off this makes.)

Registry sizes: Clara 20 tools, Dora 13, Otto 6.

## 2.5 Structured output

Two mechanisms, chosen by lane.

**Lane A** — `getGateway().generateStructured({ role, schema, ... })`, which
posts a `responseSchema` to Gemini and validates the parsed result, throwing
`StructuredOutputError` on mismatch. Used by extraction, overview, fit,
matching, classification, reranking.

**Lane B** — `model.withStructuredOutput(ZodSchema, { name })`. Exactly one
graph uses this, Otto's planner:

```ts
// lib/ai/otto/graph.ts
const PlanSchema = z.object({
  milestoneIds: z.array(z.enum(MILESTONE_IDS)).min(1).max(MILESTONE_IDS.length),
});

const planner = model.withStructuredOutput(PlanSchema, { name: "onboarding_plan" });
const result  = await planner.invoke([new SystemMessage(buildPlannerPrompt(...))], config);
```

Note the belt-and-braces: the enum is built from the milestone registry so the
model *cannot* name a milestone that does not exist, and the result still goes
through `sanitizePlan()`, which re-enforces role, feature availability and
prerequisite order **in code**. A planner exception falls back to registry
order, because a planner failure must never leave a user with no onboarding at
all. That pattern — *schema constrains, code enforces, failure degrades* — is
the house style and should be copied.

## 2.6 Streaming

Two streaming shapes exist.

### Graph streaming — `streamEvents` v2

The agents stream through LangGraph, covered in
[§3.6](03-langgraph.md#36-streaming-streamevents-v2) and
[§5](05-turn-lifecycle.md).

### Direct model streaming — `.stream()`

Dora's single-point document edits do not go through a graph at all. They
stream tokens straight into the ONLYOFFICE document:

- [`dora/edit-stream-turn.ts`](../../lib/ai/dora/edit-stream-turn.ts) — rewrite
  selection / continue writing, on the `dora_fast` role, chosen for
  first-token latency over planning depth.
- [`dora/spreadsheet/edit.ts`](../../lib/ai/dora/spreadsheet/edit.ts) — cell
  operations, `temperature: 0.1`, `reasoningEffort: "low"`.
- [`dora-gateway/edit-v2.ts`](../../lib/dora-gateway/edit-v2.ts).

These are legitimate non-graph uses: there is no multi-step tool reasoning and
no conversational memory to checkpoint. They are, however, **completely
untraced** today and each one is a separate model call the metrics never see.

## 2.7 Multi-provider readiness — is it real?

Partly. Honest assessment:

| Capability | Gemini | OpenAI | Anthropic |
|---|---|---|---|
| Chat + tool calling via `getChatModel` | ✅ exercised daily | ⚠️ code path exists, unexercised | ⚠️ code path exists, unexercised |
| Reasoning-effort mapping | ✅ | ✅ written | ✅ written |
| Lane A (`embed`, `generateStructured`) | ✅ | ❌ no adapter | ❌ no adapter |
| Native web search (`dora_gaeb_web`) | ✅ `googleSearch` | ❌ | ❌ |

So: **the agents are provider-portable in principle and Gemini-only in
practice.** The `dora_gaeb_web` role is explicitly documented to degrade to "no
evidence" when the configured provider cannot search. Before claiming
portability to anyone, run the smoke test (`npm run ai:agent:smoke`) against the
target provider and expect to find at least the history-hygiene assumptions in
[`tool-loop.ts`](../../lib/ai/agent/tool-loop.ts) to be Gemini-shaped.

## 2.8 Testing the LangChain layer

Two seams, both good.

**`setAgentModelForTests(model)`** — a module-level override in `model.ts` that
short-circuits the factory. Pass `null` to restore.

**`FakeToolCallingChatModel`** ([`agent/testing.ts`](../../lib/ai/agent/testing.ts))
— a real `BaseChatModel` subclass replaying a scripted queue of `AIMessage`s.
The subtle part is `bindTools`:

```ts
override bindTools(): FakeToolCallingChatModel {
  const bound = new FakeToolCallingChatModel([]);
  bound.queue = this.queue;   // shared reference
  bound.calls = this.calls;   // shared reference
  bound.toolsBound = true;
  return bound;
}
```

Because the queue and call log are *shared* between the bound and unbound
views, a test can assert that the finalize path invoked the model **with no
tools bound** — `calls[i].withTools === false` — which is the whole point of
that path. It also implements `_streamResponseChunks` so `streamEvents` sees
realistic token deltas and `tool_call_chunks`.

Graph tests additionally mock the checkpointer to `MemorySaver` and stub
`ToolNode`; see [`agent/graph.test.ts`](../../lib/ai/agent/graph.test.ts) and
[`otto/graph.test.ts`](../../lib/ai/otto/graph.test.ts).
