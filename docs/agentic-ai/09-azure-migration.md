# 9. The Azure migration — what happened, and what is left

A record of the move from Gemini to Azure OpenAI `gpt-5.6-luna`, written for
whoever picks this up next. Section 9.1 is what the live deployment actually
does, because most of it contradicts what the documentation predicted. Section
9.4 is the backlog.

## 9.1 What the probe found

`npm run ai:azure:probe` asks the live endpoint every question the integration
depends on. It exists because the first version of this plan was built on
assumptions, and the probe overturned two of them within a minute of running.

| # | Finding | Consequence |
|---|---|---|
| P1 | The resource serves **only** `{endpoint}/openai/v1/…`, with no `api-version`. The classic `/openai/deployments/{d}/…?api-version=` route 404s for everything. | `AzureChatOpenAI` is unusable — it hard-codes the deployment-scoped base URL. We use plain `ChatOpenAI` pointed at the v1 surface. |
| P2 | The wire wants the **deployment name** in `model`; the real model id returns `DeploymentNotFound`. | But LangChain reads that same field for capability detection. Irreconcilable in one string, so the transport swaps it on the way out. |
| P3 | `max_tokens` is a hard 400 ("use `max_completion_tokens`"). | Which is gated on `isReasoningModel(model)` — hence P2's swap rather than simply sending the deployment name. |
| P4 | `temperature` accepts only its default of 1. | The azure branch never sends one. Six call sites that passed 0 or 0.1 are now no-ops; `dora_fast`'s deliberate 0.4 warmth moved into its prompt. |
| P5 | Effort ladder is `none, low, medium, high, xhigh`. `minimal` and `max` are rejected. | The product ladder has six rungs, so every provider branch clamps. |
| P7 | Strict `json_schema` accepts bounds keywords but rejects a partial `required`: *"required … to be an array including every key in properties"*. | The schema adapter's null-widening rule is mandatory, not defensive. |
| P9 | Native PDF input works and **requires** `filename`. | Our attachment blocks already set it. |
| P10 | `web_search` works on Responses and returns `url_citation` annotations. | GAEB web pricing is restored rather than lost. |
| P11 | Prompt caching is live — 8 526 of 8 529 tokens served warm. | Long stable system prompts are worth keeping stable. |
| **P12** | **The content filter blocks ordinary German procurement text.** A Leistungsverzeichnis covering *Sprengarbeiten*, a *Justizvollzugsanstalt* and medical waste was blocked outright — as an **HTTP 200** with `finish_reason: "content_filter"` and empty content. | Its own error class, its own user-facing message, and runbook R10. This is BAU AI's core domain, not an edge case. |
| P14 | An exhausted budget also returns HTTP 200, `finish_reason: "length"`, empty content. | Reported as truncation naming `AI_ROLE_MAX_OUTPUT_TOKENS`, not as "non-JSON output". |

One more, found by the implementation spike rather than the probe, and the
single most consequential fact in the migration:

> `/v1/chat/completions` rejects function tools combined with any
> `reasoning_effort` above `none`: *"Function tools with reasoning_effort are
> not supported for luna-dev in /v1/chat/completions. To use function tools,
> use /v1/responses or set reasoning_effort to 'none'."*

Every agent here is a tool loop and per-role effort is the point of the
migration, so **the Responses API is mandatory**, not a preference. That flipped
`AI_AZURE_RESPONSES` from a cautious opt-in to a default-on setting whose
escape hatch costs reasoning on every tool-calling role.

## 9.2 Two library bugs worth remembering

**`reasoningEffort` is a call option, not a constructor field.** The existing
`openai` branch had passed it to the constructor since it was written, so it
had **never** sent `reasoning_effort` at all. Nobody noticed because §2.7
recorded that path as "unexercised". Fixed to `reasoning: { effort }`.

**`tokenCounter: model`** — suggested by §6.3 and accepted by `trimMessages` —
fetches a tiktoken encoding over the network on the hot path, and counts image
and file blocks as **zero**. A fill-agent window of 50 rendered pages would
measure as nothing and never trim.

## 9.3 What this migration deliberately did not do

- **Move embeddings.** The one role configuration cannot change: it means
  re-embedding every stored vector and rebuilding both Atlas vector indexes.
  `AzureOpenAIProvider.embed()` throws with that explanation.
- **Adopt `createAgent`.** LangGraph v1 deprecates `createReactAgent` in favour
  of `createAgent` plus middleware — but this codebase never used the prebuilt,
  and `StateGraph`, `Annotation.Root`, `ToolNode` and checkpointers are all
  current. Nothing here is deprecated. See §9.4.
- **Collapse the workarounds the migration made obsolete.** The brief's
  two-call split and the GAEB two-step both outlived their original Gemini
  reasons; both earned new ones, and the comments now say so. The Gemini
  history hygiene in `tool-loop.ts` stays untouched — it turned out to be
  portable, and it must outlive the rollback window regardless.

## 9.4 Backlog

Ordered by what would pay off soonest.

### Raise the deployment quota (blocking for production)

**`luna-dev` is provisioned at 10 000 tokens/minute and 10 requests/minute.**
Measured from the response headers:

```
x-ratelimit-limit-tokens=10000   x-ratelimit-limit-requests=10
```

That is a development allowance, and two of our workloads do not fit inside it
*at all*:

- **The report's translation pass cannot succeed.** Translating a finished
  report means sending it back as input: ~52 000 characters, roughly 15 000
  tokens in one request. A single call exceeds the per-minute token budget, so
  it 429s no matter how long you wait between attempts. This was observed live
  — the German analysis completed and persisted, and the English translation
  failed. The degradation is correct by design (a failed translation must not
  lose the analysis, so the language is simply absent and the reader falls back
  with a notice) but the English report will never appear until the quota rises.
- **The match judge would be crippled.** ~20 judge calls per company per
  refresh against a 10 RPM ceiling means a single company's refresh takes two
  minutes of pure rate-limit waiting, and concurrent tenants queue behind it.

Nothing in the code can work around this; it is a capacity purchase. Until it
is raised, expect `rate_limited` on any report, and treat single-language
reports as expected rather than as a bug.

### Finish the canary

Verified end to end against the live deployment: `agent` (multi-tool loop with
streaming), `otto`, `dora_fast`, `extraction` (Lane A), `dora_gaeb_web` (web
search with real citations), `dora_gaeb_fill` (classify + pricing),
`dora_pdf_fill` (native PDF + vision + strict schema), and `report` (full
German report, 8 sections, 31 citations, stamped `azure:gpt-5.6-luna`).

Still unexercised: **`fill_agent`** (it drives the Python sandbox, so it needs
the sidecar running), **`dora`** chat inside a live ONLYOFFICE session, and
**`match`** — which is blocked on the quota above rather than on correctness.
`dora_edit_transactions` records the real failure codes; trust it over the UI.

### Content-filter policy (highest operational risk)

P12 is not hypothetical: it blocked a realistic Leistungsverzeichnis on the
first attempt. Two things are needed.

1. **Decide the Foundry policy.** Content-filter severity is configurable per
   deployment. Lowering the violence threshold for this workload is defensible
   and should be a documented decision, not a surprise.
2. **Measure the real rate.** Run a batch of production tenders through
   classification and count `content_filtered`. If it is more than a fraction
   of a percent, the pipeline needs a fallback path — most likely routing
   blocked documents to the Gemini role, which has no equivalent filter.

### Cost telemetry, then match effort

`match` is the top cost-watch item: roughly 20 judge calls per company per
refresh, swept for every tenant. It ships at `medium` effort because matching
quality is a known product gap and effort is the right lever — but that is a
judgement made without data. The migration proposal's €12k incident happened in
a system with no cost telemetry, and this one still has none. Langfuse (§7) is
the existing plan; until it exists, `AI_ROLE_REASONING={"match":"low"}` is the
one-line brake.

### Prompt caching is live but unmeasured

P11 showed 8 526 of 8 529 tokens served warm on a synthetic prefix, and
`promptCacheKey` is set per role. Nobody has checked what the real hit rate is
under production traffic, or whether the prompts are ordered to maximise it
(long stable prefix first, varying tail last). Cheap to check once traces exist.

### Retire the compatibility layer

Once Azure has run without a rollback for long enough to trust it:

- The `AI_*_MODEL` per-role shortcuts exist as the rollback path. They can go,
  or be documented as permanent, but not left ambiguous.
- `agentMaxOutputTokens` is marked `@deprecated` and superseded by
  `roleMaxOutputTokens`.
- `reportMaxOutputTokens` / `reportReasoningEffort` are likewise superseded.
- The Gemini-shaped comments in `schema.ts`, `schema-gaeb.ts` and `tool-loop.ts`
  describe constraints that no longer bind the default provider. **Do not
  remove them until Gemini is genuinely gone** — §6.0.5 is right that each is a
  paid-for bug with the receipt attached.

### Evaluate `createAgent` on its own

LangChain v1's middleware now covers several things this codebase hand-rolls:
`toolCallLimitMiddleware` with `exitBehavior: "end"` is essentially our
forced-finalize path, `summarizationMiddleware` and `contextEditingMiddleware`
overlap §6.3, and `modelFallbackMiddleware` would give a Gemini fallback for
free. Worth a real evaluation — but on its own, not bundled with anything else.
It would rewrite five graphs, Otto embeds the loose tool-loop nodes in its own
milestone graph that `createAgent` does not model, and it changes message
shapes on a frozen-key checkpoint store.

### Smaller items

- **`AZURE_CLIENT_SECRET` is in `.env.local` in plaintext.** Correctly
  gitignored, so not committed — but deployed environments should use managed
  identity. `getAzureTokenProvider` already supports both with no code change;
  only the environment needs to change.
- **`NATIVE_PDF_MAX_BYTES = 8 MB`** is a Gemini-shaped limit mirrored in three
  files. P9 confirmed PDFs work but did not establish Azure's ceiling. If it is
  lower, `shouldSendPdfNatively` rejects at the wrong threshold — or worse,
  sends a request that 413s.
- **The correlation id from §6.5** is still outstanding; it was scoped to arrive
  with tracing and that argument still holds.
- **`fill-agent/planner.ts` still fence-strips free-form JSON** (`invokeJson`)
  where its schemas are already Zod. Now that strict `json_schema` is available
  and verified, that hack can go.
- **The probe should run in CI** against a non-production deployment. It is the
  only thing standing between a model upgrade and a silent capability
  regression.
