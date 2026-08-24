# 7. Observability with Langfuse

> **Status: Proposed.** Nothing in this section is implemented. Langfuse appears
> in this repo exactly once — as a commitment in
> [`docs/migration-docs/bauai-nextjs-migration-proposal.md`](../migration-docs/bauai-nextjs-migration-proposal.md)
> §2.8: *"Every agent a LangGraph graph (done) traced in Langfuse (to deploy)."*
> This is the design that discharges that commitment.
>
> API details are written against **Langfuse JS/TS SDK v5** (`@langfuse/*`
> scoped packages, current `@langfuse/langchain` 5.10.1). The unscoped
> `langfuse` / `langfuse-langchain` packages are the legacy v3 SDK — **do not
> install them.** Verify signatures against the version you actually install;
> this SDK line has had two breaking majors in a year.

## 7.1 What we have today, precisely

| Signal | Exists? | Where |
|---|---|---|
| Per-turn `llmCalls`, `inputTokens`, `outputTokens`, `durationMs` | ✅ | `chat_messages.metrics` |
| Per-tool name + duration + `resultCount` | ✅ | `chat_messages.toolEvents` |
| Prompt text actually sent to the model | ❌ | reconstructable only by re-running the builder |
| Which tools were considered but not called | ❌ | — |
| Cost in currency | ❌ | — |
| Cost attributed to tenant / user / feature | ❌ | — |
| Cross-turn or cross-agent aggregation | ❌ | one Mongo doc per message, no rollups |
| Anything about lane A (embedding, extraction, matching, overview, fit) | ❌ | — |
| Anything about the ~15 non-graph model call sites (report, verdict, brief, edits, fill, GAEB) | ❌ | — |
| Error detail beyond `"failed"` | ❌ | one `log.error` line, no ids |
| Latency breakdown inside a turn | ❌ | — |
| Prompt/model version attached to an output | ❌ | constants exist, nothing stamps them |

Repo-wide there is **no** `opentelemetry`, `sentry`, `datadog`, `langsmith`,
`helicone` or `langfuse` dependency.

The gap that matters most operationally: **the €12k April 2026 API-cost
incident** described in the migration proposal happened in a system with no cost
telemetry, and the current system also has none. We would find out the same way:
the invoice.

## 7.2 Why Langfuse specifically

- **Native LangChain/LangGraph callback handler.** One `CallbackHandler` in the
  run config produces a correctly nested trace — graph → node → LLM call → tool
  call — with zero changes to `tool-loop.ts`. No other option gives us lane B
  for free.
- **OpenTelemetry-based in v5.** Traces are OTEL spans, so lane A, the workers
  and the HTTP layer can be instrumented with the same primitives instead of a
  second vendor SDK.
- **Self-hostable.** Tender documents and company profiles are customer
  confidential; a self-hosted deployment plus the `mask` hook keeps that data
  under our control. See [§7.9](#79-privacy-masking-and-what-must-never-leave).
- **Sessions, users, scores, datasets, prompt management** are first-class —
  which maps onto the four things we cannot currently do: correlate a
  conversation, attribute cost to a tenant, measure a prompt change, and version
  a prompt.

## 7.3 Target trace taxonomy

Decide this **before** writing code; renaming traces later invalidates every
saved dashboard.

```
trace                       name = "clara.chat" | "dora.chat" | "dora.spreadsheet.chat" | "otto.chat"
│                           sessionId = thread key (clara:…, dora:…, otto:…)
│                           userId    = better-auth user id
│                           tags      = [agent, locale, tenantId, scope]
│
├── span   LangGraph:beginTurn
├── span   LangGraph:model
│    └── generation  ChatGoogleGenerativeAI     ← model, input, output, usage, cost
├── span   LangGraph:tools
│    ├── span  tool:get_extractions
│    └── span  tool:search_tender_documents
├── span   LangGraph:model
│    └── generation …
└── span   LangGraph:finalize
     └── generation …
```

Conventions to fix now:

| Field | Value | Why |
|---|---|---|
| `traceName` | `"{agent}.{surface}"` — `clara.chat`, `dora.fill.gaeb`, `otto.chat` | groups cleanly in the UI and in metrics queries |
| `sessionId` | **the LangGraph thread key** | one Langfuse session == one conversation, for free, and it is already server-derived and tenant-scoped |
| `userId` | better-auth user id | per-user cost and volume |
| `tags` | `agent:clara`, `locale:de`, `tenant:{id}`, `scope:tender` \| `scope:global` | tag filters are the cheapest slice in the UI |
| `metadata` | `promptVersion`, `graphVersion`, `modelRole`, `threadId`, `tenderId`, `documentId`, `correlationId` | **v5 requires `Record<string, string>`, values ≤ 200 chars** — stringify ids, never nest objects |
| `environment` | `LANGFUSE_TRACING_ENVIRONMENT` = `development` \| `staging` \| `production` | keeps dev noise out of production dashboards |
| `release` | `LANGFUSE_RELEASE` = git sha | "did the deploy break it" is one filter |

**`sessionId` = thread key is the single highest-value decision here.** It makes
"show me this customer's whole conversation, every model call, every tool, with
cost" a one-click operation, and it costs nothing because we already derive
the key server-side.

## 7.4 Phase 0 — bootstrap

### Install

```bash
npm install @langfuse/tracing @langfuse/otel @langfuse/client @langfuse/langchain @opentelemetry/sdk-node
```

### Environment

```bash
# .env.local / deploy env
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_BASE_URL=https://langfuse.internal.bau-ai...   # self-hosted
LANGFUSE_TRACING_ENVIRONMENT=production                  # development | staging | production
LANGFUSE_RELEASE=${GIT_SHA}
LANGFUSE_SAMPLE_RATE=1.0                                 # see §7.10
# LANGFUSE_DEBUG=true                                    # only when diagnosing missing spans
```

Add these to `lib/ai/config/env.ts` as an **optional** block — tracing must
never be a startup dependency:

```ts
// lib/ai/config/env.ts (additions)
langfuseEnabled: boolFromEnv("false"),
langfuseSampleRate: z.coerce.number().min(0).max(1).default(1),
langfuseMaskDocumentText: boolFromEnv("true"),
```

Everything below must degrade to a no-op when `langfuseEnabled` is false. That
is not optional politeness — it is what lets us ship this behind a flag and roll
it back without a deploy.

### Shared processor module

One module owns the processor instance, because flushing needs a handle on it.

```ts
// lib/observability/langfuse.ts
import { LangfuseSpanProcessor } from "@langfuse/otel";

let processor: LangfuseSpanProcessor | null = null;

export function getLangfuseSpanProcessor(): LangfuseSpanProcessor | null {
  if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) return null;
  processor ??= new LangfuseSpanProcessor({
    publicKey: process.env.LANGFUSE_PUBLIC_KEY,
    secretKey: process.env.LANGFUSE_SECRET_KEY,
    baseUrl:   process.env.LANGFUSE_BASE_URL,
    mask: maskSensitive,          // §7.9
  });
  return processor;
}

/** Flush in environments that may freeze the process (serverless, workers). */
export async function flushLangfuse(): Promise<void> {
  await processor?.forceFlush().catch(() => {});
}
```

### Next.js server

```ts
// instrumentation.ts  (repo root — Next 16 supports this natively, no config flag)
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;   // Langfuse OTEL is Node-only
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getLangfuseSpanProcessor } = await import("./lib/observability/langfuse");
  const processor = getLangfuseSpanProcessor();
  if (!processor) return;
  new NodeSDK({ spanProcessors: [processor] }).start();
}
```

> `register()` runs **once per server instance** and must complete before the
> server serves requests. Keep it to SDK startup — no network calls, no DB.

### Workers

The BullMQ workers are plain Node scripts (`node --experimental-strip-types
workers/*.mts`), **not** Next.js — `instrumentation.ts` never runs for them.
Each worker entry point needs its own bootstrap:

```ts
// workers/otel-bootstrap.mts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getLangfuseSpanProcessor, flushLangfuse } from "../lib/observability/langfuse.ts";

const processor = getLangfuseSpanProcessor();
if (processor) {
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, async () => { await flushLangfuse(); await sdk.shutdown(); process.exit(0); });
  }
}
```

```jsonc
// package.json — add --import to each worker script
"worker:ai": "node --import ./workers/otel-bootstrap.mts --experimental-strip-types workers/ai-indexer.mts"
```

Forgetting this is the classic way to end up with "AI matching has no traces"
three weeks after launch.

## 7.5 Phase 1 — trace the four agents

This is the whole of lane B, and it touches **two files**.

### `runChatTurn` builds the handler and propagates attributes

```ts
// lib/ai/agent/service.ts
import { CallbackHandler } from "@langfuse/langchain";
import { propagateAttributes, getActiveTraceId } from "@langfuse/tracing";

export interface AgentTraceInfo {
  /** "clara.chat" | "dora.chat" | "dora.spreadsheet.chat" | "otto.chat" */
  name: string;
  promptVersion: string;
  graphVersion: string;
  modelRole: string;
}

// inside runChatTurn, replacing the bare streamEvents call:
const tracing = aiEnv().langfuseEnabled;
const handler = tracing ? new CallbackHandler() : null;

const runTurn = async () => {
  const stream = graph.streamEvents(
    { messages: [new HumanMessage({ content: turnContent as never })] },
    {
      version: "v2",
      configurable: { thread_id: input.threadKey },
      signal,
      ...(handler ? { callbacks: [handler] } : {}),
      runName: trace.name,
    },
  );
  for await (const event of stream) { /* …unchanged… */ }
};

if (tracing) {
  await propagateAttributes(
    {
      traceName: trace.name,
      userId:    ctx.userId,
      sessionId: input.threadKey,                    // ← the whole conversation
      tags: [
        `agent:${trace.name.split(".")[0]}`,
        `locale:${ctx.locale}`,
        `tenant:${ctx.tenantId.toHexString()}`,
        ctx.tender ? "scope:tender" : "scope:global",
      ],
      metadata: {                                     // Record<string, string> only
        promptVersion: trace.promptVersion,
        graphVersion:  trace.graphVersion,
        modelRole:     trace.modelRole,
        threadId:      String(threadId),
        correlationId: String(userMessage._id),
        ...(ctx.tender ? { tenderId: ctx.tender.tenderId.toHexString() } : {}),
      },
    },
    runTurn,
  );
} else {
  await runTurn();
}
```

Three things to get right:

1. **`callbacks` goes in the run config, and every node already forwards
   `config`.** `tool-loop.ts` threads `config` into `boundModel.invoke(...)` and
   `model.invoke(...)` — that is what propagates the callback manager. If
   someone ever adds a node that drops `config`, that node's model call
   disappears from the trace *and* stops streaming. The two failures are the
   same bug, which is a useful property.
2. **`propagateAttributes` wraps a callback.** Spans created *before* the
   callback are not retroactively updated — so it must wrap the streaming loop,
   not be called inside it.
3. **`metadata` values must be strings ≤ 200 chars in v5.** Non-strings get
   `JSON.stringify`d; nested objects will surprise you.

### Capture the trace id for support

```ts
const traceId = tracing ? getActiveTraceId() : null;   // inside the propagate callback
```

Persist it alongside the metrics and return it in the `error` SSE frame:

```ts
metrics: { llmCalls, inputTokens, outputTokens, durationMs, traceId }
```

This is the fix for [§6.5](06-review.md#65-every-failure-is-failed): a user
reports "it failed", support reads the trace id off the message, pastes it into
Langfuse, and sees the exact prompt, the exact tool results and the exact
provider error.

### Flushing — the SSE trap

Our turn runs **inside a `ReadableStream`'s `start()`**, which continues after
the route handler has returned its `Response`. A flush at handler return is too
early; on a serverless runtime the process can freeze with spans still buffered.

Flush in the stream's `close()` path instead:

```ts
// lib/ai/agent/sse-turn.ts
const close = () => {
  if (!open) return;
  open = false;
  clearInterval(heartbeat);
  clearTimeout(timeout);
  try { controller.close(); } catch { /* already closed */ }
  void flushLangfuse();          // ← after the last frame, never blocking it
};
```

On a long-running Node server this is belt-and-braces (the batch processor
flushes on its own schedule); on serverless it is the difference between having
traces and not.

### Per-agent trace info

| Agent | `name` | `promptVersion` | `graphVersion` | `modelRole` |
|---|---|---|---|---|
| Clara | `clara.chat` | `CLARA_SYSTEM_PROMPT_VERSION` = `clara-p3` | `clara-chat-v1` | `agent` |
| Dora | `dora.chat` | `DORA_SYSTEM_PROMPT_VERSION` = `dora-p2` | `dora-chat-v1` | `dora` |
| Dora-Spreadsheet | `dora.spreadsheet.chat` | `DORA_SPREADSHEET_PROMPT_VERSION` = `dora-sheet-p3` | `dora-chat-v1` | `dora` |
| Otto | `otto.chat` | **none exists** — add `OTTO_SYSTEM_PROMPT_VERSION` to `otto/prompt.ts` | `otto-onboarding-v1` | `otto` |

Otto is the one agent with no prompt-version constant (`otto/threads.ts` has
`OTTO_GRAPH_VERSION`, `otto/prompt.ts` has nothing). Add one as part of this
phase, or Otto's prompt changes stay unattributable while the other three
become measurable.

[§6.12c](06-review.md#612-smaller-items) notes these version constants exist but
are never attached to anything. This is where they become useful.

## 7.6 Phase 2 — instrumenting lane A and the non-graph call sites

The LangChain handler covers the four graphs. It covers **nothing else** —
which is most of the LLM spend.

### The non-graph LangChain call sites (~15)

These already use `getChatModel`, so they can take a handler the same way:

```ts
// lib/ai/report/service.ts (pattern)
const model = await getChatModel({ role: "report" });
const result = await model.invoke(messages, {
  ...(handler ? { callbacks: [handler] } : {}),
  runName: "report.generate",
});
```

Better: fold it into the factory so no call site can forget. Add an optional
`trace` option to `getChatModel` that returns a model with the handler already
bound via `.withConfig({ callbacks: [handler] })`, and make the surface name a
required argument for non-`agent` roles.

Priority order, by spend:

1. `report/service.ts` — 32 768 output tokens, top-tier model, `high` reasoning
2. `match/judge.ts` — 200 tenders per company per run, batched
3. `dora/fill/gaeb/analyze-gaeb.ts` — up to 3 000 positions in batches of 20
4. `dora/fill/pdf/analyze-pdf.ts`, `dora/fill/analyze.ts`
5. `verdict/service.ts`, `dora/brief.ts`
6. `dora/edit-stream-turn.ts`, `dora/spreadsheet/edit.ts`, `dora-gateway/edit-v2.ts`

Items 1–3 are almost certainly the top three cost lines in the system and none
of them is visible today.

### Lane A — the gateway

`lib/ai/gateway/providers/gemini.ts` is raw `fetch`. It emits no LangChain
callbacks and never will. Instrument it **once, in the gateway**, not at the 17
call sites:

```ts
// lib/ai/gateway/index.ts
import { startActiveObservation, updateActiveObservation } from "@langfuse/tracing";

class RoleRoutingGateway implements ModelGateway {
  async generateStructured<T>(request: GenerateStructuredRequest<T>) {
    const ref = resolveRole(request.role);
    if (!aiEnv().langfuseEnabled) return getProvider(ref.provider).generateStructured(ref.model, request);

    return startActiveObservation(
      `gateway.generateStructured:${request.role}`,
      async (span) => {
        span.update({
          model: `${ref.provider}:${ref.model}`,
          input: request.prompt,
          metadata: { role: request.role, schema: request.schemaName ?? "" },
        });
        const result = await getProvider(ref.provider).generateStructured(ref.model, request);
        span.update({
          output: result.value,
          usageDetails: {
            input:  result.usage?.promptTokenCount ?? 0,
            output: result.usage?.candidatesTokenCount ?? 0,
          },
        });
        return result;
      },
      { asType: "generation" },     // ← generation, not span: this is what gets costed
    );
  }
}
```

`embed()` gets the same treatment with `asType: "embedding"` and the batch size
in metadata. **Do not put embedding *inputs* in the span** — a batch of 64
document chunks per call, at ~500 tokens each, would dominate storage for no
diagnostic value. Record counts and hashes.

Once lane A is wrapped, the pipelines running inside BullMQ workers produce
traces automatically, provided the worker bootstrap from
[§7.4](#74-phase-0--bootstrap) is in place.

### Correlating a pipeline run

Extraction, matching and GAEB fill are multi-call jobs. Wrap the **job**, not
just the calls, so the individual generations nest under one trace:

```ts
// lib/ai/match/job.ts (pattern)
await propagateAttributes(
  {
    traceName: "match.run",
    sessionId: `match:${tenantId.toHexString()}`,
    metadata: { runId: String(runId), pipelineVersion: env.matchPipelineVersion },
    tags: [`tenant:${tenantId.toHexString()}`, "surface:match"],
  },
  () => runMatchPipeline(...),
);
```

Now "this company's matching run cost X and judged 200 tenders in Y seconds" is
a single trace.

## 7.7 What the traces make answerable

| Question | Today | With Langfuse |
|---|---|---|
| Why did Clara say that? | re-run the prompt builder and guess | open the trace, read the exact prompt and every tool result |
| What does one Clara turn cost? | unknown | on the trace |
| What does one customer cost per month? | unknown | filter by `userId` / `tenant:` tag |
| Which feature is the top cost line? | unknown | group by `traceName` |
| How often does the finalize path fire? | unknown | count spans named `LangGraph:finalize` |
| How often do we hit the iteration cap? | unknown | traces with `llmCalls >= cap` |
| Did `clara-p4` beat `clara-p3`? | unmeasurable | filter by `promptVersion` metadata, compare scores |
| Is Gemini rejecting our history? | one `"failed"` string | the provider error on the failed generation |
| Did the deploy 20 minutes ago break Dora? | unknown | filter by `release` |
| Which tool is slowest? | `toolEvents.durationMs` per message, no rollup | tool-span latency percentiles |

### Dashboards to build first

1. **Cost by `traceName`, daily** — the €12k-incident detector.
2. **Cost by tenant tag, monthly** — unit economics per customer.
3. **P50/P95 turn latency by agent** — the number users feel.
4. **Error rate by `traceName` and provider status** — the thing that is
   currently one undifferentiated `"failed"`.
5. **`LangGraph:finalize` span rate** — a pure quality signal; every finalize is
   a turn that ran out of budget mid-investigation.
6. **Tokens per turn distribution** — tells you whether
   [§6.3](06-review.md#63-the-effective-memory-window-is-much-shorter-than-30-messages)'s
   history window is actually binding.

### Alerts

| Alert | Threshold | Why |
|---|---|---|
| Daily spend | > 2× trailing 7-day median | the incident class this whole exercise exists to prevent |
| Single trace cost | > €1 | a runaway loop or an uncapped tool result |
| `match.run` cost | > budget × rank cap | matching is the highest-volume LLM surface |
| Error rate by agent | > 2 % over 15 min | provider or prompt regression |
| P95 turn latency | > 60 s | approaching the point where users abandon |

## 7.8 Phase 3 — datasets and evaluation

This is the answer to [§6.11](06-review.md#611-there-is-no-agent-evaluation-harness).

### Datasets

Version a set of scenarios per agent:

| Dataset | Items | Expected |
|---|---|---|
| `clara-tender-qa` | (tenderId, question, locale) over tenders with known extractions | the fact, the file it must be cited from |
| `clara-global-discovery` | free-text "find me tenders for X" | tender ids that must appear |
| `dora-fill` | (documentId, tenderId) pairs with a hand-checked fill | field → value |
| `otto-onboarding` | (role, matchEnabled, profile answers) | the milestone plan |

### Scores — rule-based first

LLM-as-judge is expensive and noisy. Everything below is deterministic, cheap,
and catches most regressions:

| Score | Type | Computed from |
|---|---|---|
| `hit_iteration_cap` | BOOLEAN | a `LangGraph:finalize` span exists |
| `cited_real_file` | BOOLEAN | every cited file name exists in `tender_documents` |
| `no_invented_ids` | BOOLEAN | no raw ObjectId appears in the answer text (the prompt forbids it) |
| `answered_in_locale` | BOOLEAN | language detection vs `ctx.locale` |
| `tool_order_respected` | NUMERIC | did it call `get_extractions` before `search_tender_documents`? |
| `turn_cost_eur` | NUMERIC | from the trace |
| `plan_sanitizer_drops` | NUMERIC | Otto: milestones the registry refused |

```ts
// scripts/ai-agent-eval.mts (sketch)
import { LangfuseClient } from "@langfuse/client";
const langfuse = new LangfuseClient();

langfuse.score.create({
  traceId,
  name: "cited_real_file",
  value: citedFilesAllExist ? 1 : 0,
  dataType: "BOOLEAN",
  comment: missing.length ? `missing: ${missing.join(", ")}` : undefined,
});
await langfuse.flush();
```

### User feedback → score

The chat UI has thumbs affordances or can grow them cheaply. With `traceId` on
`chat_messages.metrics`, a feedback endpoint is four lines:

```ts
// app/api/chat/messages/[messageId]/feedback/route.ts
langfuse.score.create({
  traceId: message.metrics.traceId,
  name: "user_feedback",
  value: body.helpful ? 1 : 0,
  dataType: "BOOLEAN",
  comment: body.comment?.slice(0, 500),
  id: `feedback:${messageId}`,     // idempotency — a double-click must not double-score
});
```

That closes the loop: real user judgements land on the same traces the eval
scores do.

### Prompt management — deliberately deferred

Langfuse can serve prompts from its own registry. **Do not adopt this yet.** Our
prompts are typed TypeScript functions that interpolate a run context
(`buildClaraSystemPrompt(ctx)`), reviewed in PRs and covered by
`prompt.test.ts`. Moving them into a UI trades type safety and code review for
editability we have not yet asked for. Revisit only if non-engineers need to
change prompts without a deploy — and then move *one* prompt first.

What we should adopt immediately is the cheap half: stamp `promptVersion` into
trace metadata ([§7.5](#75-phase-1--trace-the-four-agents)) so changes are
attributable.

## 7.9 Privacy, masking, and what must never leave

This is the section to get wrong at your peril. Traces will contain tender
documents, company profiles, and whatever a user typed.

### The mask hook

```ts
// lib/observability/langfuse.ts
const PATTERNS: Array<[RegExp, string]> = [
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, "«IBAN»"],
  [/\bDE\s?\d{9}\b/g, "«USt-IdNr»"],
  [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "«email»"],
  [/\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b/g, "«card»"],
];

export const maskSensitive = ({ data }: { data: string }): string => {
  let out = data;
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
};
```

Applied on the `LangfuseSpanProcessor`, so it covers observation inputs, outputs
and metadata uniformly — one place, not per call site.

### Volume controls

A `read_tender_document` result is capped at 20 000 chars; the report prompt
carries up to 40 tender chunks plus 16 company chunks. Traced verbatim, a single
report trace is hundreds of kilobytes.

- **Truncate tool outputs in traces** above a threshold, with a marker:
  `"…[truncated 18 214 chars]"`. The full text is reproducible from the tool
  call arguments; the trace does not need to be the archive.
- **Never trace embedding inputs.** Counts and hashes only.
- Consider `LANGFUSE_OBSERVE_DECORATOR_IO_CAPTURE_ENABLED=false` for the
  highest-volume pipeline paths.

### Deployment posture

**Self-host.** Tender documents and company profiles are customer confidential
and some are commercially sensitive (priced GAEB offers). Sending them to a
third-party SaaS needs a DPA and a customer-facing disclosure we do not
currently have. Self-hosting keeps the data on our infrastructure and the
decision reversible.

### Data retention

Set a Langfuse retention policy that matches the checkpoint TTL proposed in
[§6.2](06-review.md#62-checkpoints-grow-forever-and-the-read-index-is-the-wrong-shape).
Two systems with different memories of the same conversation is a compliance
question waiting to be asked.

## 7.10 Sampling, overhead and failure isolation

### Sampling

Start at **100 %** — volume is low, and a sampled trace is useless for the
"customer says it failed" workflow, which is the primary use case.

Revisit per surface when volume grows. The right shape is not a global rate but
a per-surface one: always trace chat (low volume, high diagnostic value); sample
embedding sweeps (very high volume, low per-item value).

```ts
LANGFUSE_SAMPLE_RATE=1.0
```

or, per-processor, an OTEL sampler:

```ts
import { TraceIdRatioBasedSampler } from "@opentelemetry/sdk-trace-base";
new NodeSDK({ sampler: new TraceIdRatioBasedSampler(0.2), spanProcessors: [processor] });
```

### v5's default span filter — read this before debugging "missing spans"

v5 changed the default: it exports a span only if it was created by the Langfuse
SDK, has `gen_ai.*` attributes, or comes from a known LLM instrumentation scope.
Pre-v5 behaviour exported everything.

Consequences for us:

- Our LangChain/LangGraph spans and anything we create with
  `startActiveObservation` **are** exported. Good.
- Generic HTTP/DB spans are **not**. Also good — that is noise.
- If a trace tree looks disconnected, an intermediate span was probably dropped.
  Set `LANGFUSE_DEBUG=true` and compose rather than replace the filter:

```ts
import { LangfuseSpanProcessor, isDefaultExportSpan } from "@langfuse/otel";

new LangfuseSpanProcessor({
  shouldExportSpan: ({ otelSpan }) =>
    isDefaultExportSpan(otelSpan) ||
    otelSpan.instrumentationScope.name.startsWith("bauai"),
});
```

### Failure isolation — the non-negotiable

**Tracing must never break a turn.** Concretely:

- No `await` on a Langfuse call in the request path except the final flush, and
  that one is `void`-ed with a `.catch()`.
- The handler is constructed only when `langfuseEnabled`; every call site has a
  no-op branch.
- Add a test that runs a full Clara turn with `LANGFUSE_PUBLIC_KEY` unset and a
  second with a **deliberately unreachable** `LANGFUSE_BASE_URL`, asserting the
  turn completes and persists normally in both.

If Langfuse being down can take chat down, the observability layer has become
the reliability problem it was bought to solve.

## 7.11 Rollout checklist

```
Phase 0 — bootstrap                                                     ~0.5 d
  [ ] self-hosted Langfuse reachable from app + workers
  [ ] @langfuse/{tracing,otel,client,langchain} + @opentelemetry/sdk-node
  [ ] lib/observability/langfuse.ts (processor singleton + mask + flush)
  [ ] instrumentation.ts, guarded on NEXT_RUNTIME === "nodejs"
  [ ] workers/otel-bootstrap.mts + --import on every worker script
  [ ] aiEnv(): langfuseEnabled (default FALSE), sample rate, mask flag
  [ ] verify: one hand-made trace appears, with the right environment tag

Phase 1 — lane B                                                        ~1 d
  [ ] CallbackHandler + propagateAttributes in runChatTurn
  [ ] sessionId = thread key; userId; tags; metadata (strings ≤200 chars)
  [ ] AgentTraceInfo passed from all four routes
  [ ] traceId persisted on chat_messages.metrics
  [ ] flushLangfuse() in sse-turn close()
  [ ] test: turn completes with Langfuse unset AND with an unreachable base URL
  [ ] enable in development → staging → production

Phase 2 — lane A + non-graph                                            ~2 d
  [ ] gateway generateStructured/embed wrapped (generation / embedding)
  [ ] report, match judge, GAEB fill, PDF fill wrapped — in that order
  [ ] pipeline jobs wrapped in propagateAttributes so calls nest under one trace
  [ ] verdict, brief, edit-stream, spreadsheet edit
  [ ] embedding inputs excluded; tool outputs truncated

Phase 3 — measurement                                                   ~3 d
  [ ] dashboards 1–6 from §7.7
  [ ] alerts from §7.7
  [ ] datasets: clara-tender-qa, dora-fill, otto-onboarding
  [ ] rule-based scores from §7.8 in scripts/ai-agent-eval.mts
  [ ] user-feedback endpoint → score, idempotent on messageId
  [ ] retention policy aligned with the checkpoint TTL
```

### Definition of done

A support request that says *"Clara gave me a wrong deadline yesterday"* is
resolved by: read the trace id off the message → open it in Langfuse → see the
exact system prompt, the `get_extractions` result, the model's reasoning budget,
the cost, and the version of the prompt that produced it. Today that request is
unanswerable.

---

**Sources for the Langfuse API details in this section:**
[langfuse-js](https://github.com/langfuse/langfuse-js) ·
[LangChain integration](https://langfuse.com/integrations/frameworks/langchain) ·
[JS/TS SDK overview](https://langfuse.com/docs/observability/sdk/overview) ·
[JS/TS v4 → v5 upgrade path](https://langfuse.com/docs/observability/sdk/upgrade-path/js-v4-to-v5) ·
[Advanced features](https://langfuse.com/docs/observability/sdk/advanced-features) ·
[Instrumentation](https://langfuse.com/docs/observability/sdk/instrumentation) ·
[@langfuse/langchain on npm](https://www.npmjs.com/package/@langfuse/langchain)
