# 5. A turn, end to end

One user message, from HTTP request to persisted assistant message. All four
agents share this path.

## 5.1 The full path

```
POST /api/tenders/[id]/chat                      route handler
  ├─ auth + company context gate
  ├─ ensureTenderThread / getOwnedThread          → ChatThreadDocument
  ├─ buildAgentRunContext                         → ctx (tenantId, locale, scope, collectors)
  └─ streamChatTurnResponse({ ctx, thread, body, request, buildGraph?, streamState? })
        │
        ├─ AbortController = client disconnect ⊕ 300 s hard timeout
        ├─ ReadableStream + 25 s keep-alive heartbeat
        └─ runChatTurn({ ctx, threadId, threadKey, userText, attachments, signal, callbacks })
              │
              ├─ persistChatMessage(role: "user")           ──► SSE  ready
              ├─ ctx.uiCalls.setTurnKey(userMessage._id)
              ├─ buildUserTurnContent(text, attachments)     (media_ref parts)
              ├─ buildGraph?.() ?? buildClaraGraph(ctx)      compile per turn
              │
              └─ graph.streamEvents({messages:[Human]}, {version:"v2", configurable:{thread_id}, signal})
                    │
                    ├─ on_chat_model_stream ──► SSE token
                    ├─ on_chat_model_end    ──► llmCalls++, token accounting, final text
                    ├─ on_tool_start        ──► SSE tool(start)
                    ├─ on_tool_end          ──► SSE tool(end) + tenders + ui
                    └─ on_chain_end         ──► SSE state          (Otto only)
              │
              ├─ persistChatMessage(role: "assistant", metrics)  ──► SSE message
              └─ bumpThread(+2)
```

## 5.2 The SSE contract

Framed as `event: {type}\ndata: {json}\n\n` by
[`sse-turn.ts`](../../lib/ai/agent/sse-turn.ts).

| Event | Payload | When |
|---|---|---|
| `ready` | `{threadId, messageId}` | user message persisted, before the model runs |
| `token` | `{delta}` | every streamed text delta |
| `tool` | `{name, status: "start" \| "end", resultCount?, stage?}` | tool boundaries |
| `tenders` | `{tenders: TenderRef[]}` | after a tool registers tender cards |
| `ui` | `{calls: WireUiCall[]}` | after a tool requests a frontend action |
| `state` | `{patch}` | a graph node's state update — **Otto only** (`streamState: true`) |
| `artifact` | `{artifact: "verdict", verdict}` | the verdict command path |
| `message` | `{message: WireChatMessage}` | the persisted assistant message |
| `error` | `{message: "rate_limited" \| "failed"}` | terminal failure |

Response headers that matter:

```
content-type: text/event-stream; charset=utf-8
cache-control: no-cache, no-transform
connection: keep-alive
x-accel-buffering: no          ← without this, nginx buffers the whole stream
```

**Errors never leak.** They collapse to two i18n keys:

```ts
message: error instanceof Error && /rate.?limit/i.test(error.message)
  ? "rate_limited"
  : "failed",
```

Good for security, bad for debugging — a `GraphRecursionError`, a Gemini 400 and
a Mongo timeout are indistinguishable to anyone reading the client. This is one
of the strongest arguments for [§7](07-observability-langfuse.md).

## 5.3 Abort and timeout

```ts
const turnController = new AbortController();
const timeout = setTimeout(() => turnController.abort(), TURN_TIMEOUT_MS);   // 300_000
request.signal.addEventListener("abort", () => turnController.abort(), { once: true });
```

Client disconnect and the hard timeout are composed into one signal, which is
passed into `streamEvents` config and therefore reaches every provider fetch.

The 300 s ceiling is a safety net, not a budget:

> Generous enough that no legitimate agent run ever hits it. Global chats chain
> `find_tenders` → notice → document search across up to 8 iterations; killing
> them mid-run surfaces as "Stopped" bubbles.

On abort the **partial content is still persisted** with `status: "aborted"`.
The user's half-written answer is not lost.

Heartbeat: `: keep-alive\n\n` every 25 s, so proxies do not drop an idle stream
while the model is thinking.

## 5.4 Token and text accounting

The trickiest 20 lines in the codebase. Three rules:

```ts
} else if (event.event === "on_chat_model_end") {
  llmCalls += 1;
  inputTokens  += output?.usage_metadata?.input_tokens  ?? 0;
  outputTokens += output?.usage_metadata?.output_tokens ?? 0;

  if (Array.isArray(output?.tool_calls) && output.tool_calls.length > 0) {
    // A tool-requesting turn streams no user-visible text; reset the buffer
    // so only the final answer accumulates.
    content = "";
  } else {
    // Authoritative final text (covers models/nodes that didn't stream and
    // array-parts content from thinking models).
    const finalText = textFromContent(output?.content);
    if (finalText) content = finalText;
  }
}
```

1. **Every model call counts**, including Otto's `profile` and `plan` nodes and
   the finalize retry. `llmCalls` on a turn is therefore ≥ the number of loop
   iterations.
2. **A tool-calling response resets the text buffer.** Deliberate: it discards
   any "let me look that up…" preamble so only the final answer is shown and
   persisted. The side effect is that a model which legitimately interleaves
   prose and a tool call loses the prose.
3. **`on_chat_model_end` output overwrites the streamed buffer.** This is what
   makes thinking models work — their final content is an array of parts, of
   which only some are text, and `textFromContent` is the only correct reader.

The resulting metrics land on the assistant message:

```ts
metrics: { llmCalls, inputTokens, outputTokens, durationMs: Date.now() - startedAt }
```

**This is the entire observability surface today.** No cost, no per-tool
timings beyond `toolEvents`, no prompt text, no per-call breakdown, no
cross-turn aggregation, and nothing at all for the ~15 non-graph model call
sites or any of lane A.

## 5.5 Tool events

```ts
} else if (event.event === "on_tool_start") {
  toolStarts.set(event.run_id, Date.now());
  callbacks?.onToolStart?.(event.name);
} else if (event.event === "on_tool_end") {
  const durationMs = Date.now() - (toolStarts.get(event.run_id) ?? Date.now());
  let resultCount: number | null = null;
  try {
    const parsed = JSON.parse((event.data?.output as {content?: string})?.content ?? "");
    if (Array.isArray(parsed)) resultCount = parsed.length;
  } catch { resultCount = null; }
  toolEvents.push({ name: event.name, durationMs, resultCount });
  ...
}
```

`run_id` keying is correct — it survives parallel tool calls, which a
name-keyed map would not.

`resultCount` is best-effort: it is populated only when a tool returns a JSON
array. Tools returning objects or markdown report `null`. That is fine for the
UI ("found 7 documents") but means the number is not a reliable metric.

### Draining the collectors

```ts
const refs = ctx.tenderRefs.drain();
if (refs.length > 0) callbacks?.onTenderRefs?.(refs);

const uiCalls = ctx.uiCalls.drain();
if (uiCalls.length > 0) callbacks?.onUiCalls?.(uiCalls);
```

Both drain on `on_tool_end`, so cards appear while the model is still writing
and a navigation happens immediately rather than after the sentence finishes.

At the end of the turn the **full list**, not the last drain, is persisted:

```ts
const tenderRefs = ctx.tenderRefs.list();
```

History must restore every tender the answer talks about, not just the ones from
the final tool call.

### UI-call turn keys

```ts
ctx.uiCalls.setTurnKey(String(userMessage._id));
```

Namespaces this turn's UI call ids by the user message they belong to: stable if
the turn replays, distinct from every other turn, so the client's
de-duplication cannot swallow a later turn's actions.

## 5.6 The verdict command — a non-agent turn on the agent's transport

`POST` bodies are a union:

```ts
export type ChatTurnBody =
  | { message: string; attachmentIds?: string[] }
  | { command: "verdict" };
```

The `verdict` command runs a **deterministic pipeline**, not a model tool loop.
It reuses the SSE transport (progress via `tool` events with a `stage`, result
via an `artifact` event) and then writes a linked assistant message with
`verdictId` set and `content: ""`, so history restores the card.

Worth knowing: a `chat_messages` document with empty content and a `verdictId`
is not a bug.

## 5.7 Failure modes, and what the user sees

| What happened | User sees | Where to look |
|---|---|---|
| Model returned empty text | full answer (finalize path re-asked with no tools) | — |
| Iteration cap hit | full answer, possibly hedged | `metrics.llmCalls` ≈ cap + 1 |
| Gemini 400 on malformed history | `error: failed`, empty bubble | server log `chat turn failed`; check `sanitizeToolPairs` |
| `GraphRecursionError` | `error: failed` | server log; see [§6.1](06-review.md#61-the-recursion-limit-is-two-supersteps-away) |
| Provider rate limit | `error: rate_limited` | provider console |
| Client navigated away | `status: "aborted"`, partial content persisted | log `chat turn aborted` |
| 300 s exceeded | `status: "aborted"` | log `chat turn aborted` |
| Tool threw | model receives the error as a `ToolMessage` and usually recovers | `toolEvents`; `ToolNode` `handleToolErrors` |
| `config` not forwarded in a node | answer arrives all at once, no streaming | grep for `model.invoke(` without `config` |

The middle rows are the problem: three genuinely different failures produce one
indistinguishable `"failed"`. Every one of them would be a single click in
Langfuse.
