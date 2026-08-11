# 04 — AI in and around the editor

Every route for putting AI into the document experience, what each can and cannot do, and
when to pick which. Path A is what ships today.

## The decision matrix

| | A. Side panel (**Dora**, shipped) | B. Custom sdkjs plugin (removed, resurrectable) | C. Official ONLYOFFICE AI plugin | D. Automation API connector | E. Server-side file manipulation |
|---|---|---|---|---|---|
| Runs where | Our React app, outside the iframe | Inside the editor | Inside the editor | Our page JS, drives the editor | Our backend |
| Read the document | Last **saved** version (server-side extraction; freshness via forcesave) | Live selection/forms/cells | Live selection | Live, full API | Saved versions (S3) |
| Write into the open document | ❌ (guides + copyable values) | ✅ with track changes + hash guards | ✅ (its own UX) | ✅ full editor API | Indirect: writes a NEW version; editor reloads |
| Our grounding (tender corpus, company KB, citations, tenancy) | ✅ full `lib/ai` stack | ✅ (server does the AI; plugin only applies) | ❌ generic providers, user-managed keys | ✅ (server does the AI) | ✅ |
| License | Community ✅ | Community ✅ (custom image or `pluginsData` hosting) | Community ✅ | **Developer Edition (paid)** | Community ✅ |
| UX quality | Full React/streaming/i18n | Cramped iframe, vanilla JS | ONLYOFFICE's UX | Full React + live editor | n/a |
| Maintenance | Ours, normal stack | Plugin + gateway + CORS + image/hosting | Upstream's | Connector code + license | OOXML/PDF fidelity risk |

**Rules of thumb:** analysis/guidance → A (exists). One-click apply into the live document
→ B (cheapest) or D (cleanest, if we ever buy Developer Edition). Bulk generation/filling
without an open editor → E.

## Path A — Dora, the shipped implementation

Dora is a LangGraph agent in a React panel beside the editor. Full architecture lives with
the AI docs; the ONLYOFFICE-relevant surface is:

- **Reading the document:** workspace docs have no ingestion pipeline;
  [lib/ai/dora/document-text.ts](../../lib/ai/dora/document-text.ts) extracts the current
  committed version's text on demand (unpdf/mammoth), cached in
  `workspace_document_texts` keyed `wdoc:{docId}:{sha256}`. Spreadsheets go through the DS
  `/converter` to CSV (first sheet only — always surfaced). Scanned PDFs → `no_text_layer`
  (no OCR).
- **Freshness:** "Analyze latest" calls
  [lib/ai/dora/forcesave.ts](../../lib/ai/dora/forcesave.ts) → DS `/command`
  `{c:"forcesave"}` → status-6 callback commits a version → we poll `storageRevision`.
  Community-Edition-legal; no plugin needed. DS errors `4`/`1` mean "already fresh".
- **Brief + chat:** `document_briefs` (+ runs) and Dora chat routes under
  `app/api/workspace-documents/[documentId]/dora/`. The v1 boundary is deliberate and in
  Dora's system prompt: *she never claims to have edited the file*.
- ⚠ Extending the brief schema: `gemini-3.5-flash` 400s on structured-output schemas with
  `.nullable()` or more than ~4 array-of-object properties — hence the split
  analysis/plan schemas + translate pass in
  [lib/ai/dora/brief-schema.ts](../../lib/ai/dora/brief-schema.ts). Don't merge them.

## Path B — resurrecting in-editor apply (the removed plugin)

Everything needed is in git history; the design (grant exchange, `expectedHash` guards,
`SetAssistantTrackRevisions`) is documented in [03-plugins.md](03-plugins.md).

Shopping list to bring it back:

1. **Plugin files** — `git show 7eed0aa:docker/onlyoffice/plugin/{config.json,index.html,plugin.js,styles.css}`.
   Host either by baking an image again (`7eed0aa:docker/onlyoffice/Dockerfile`) or — better —
   serve the folder from our app (`public/sdkjs-plugins/…`) and rely on
   `editorConfig.plugins.pluginsData` (no custom DS image; mind CORS headers on the files).
2. **Config block** in `buildOnlyOfficeConfig` — `git show 7eed0aa:lib/onlyoffice/config.ts`
   (plugins `autostart`/`pluginsData`/`options`); re-add a feature flag (the old
   `ONLYOFFICE_AI_ENABLED` was removed).
3. **Gateway** — `git show 7eed0aa:app/api/onlyoffice/ai/token/route.ts` and
   `…/operations/route.ts`, plus `lib/onlyoffice/{ai-schema,ai-service,plugin-auth}.ts`.
   The token helpers were deleted from `lib/onlyoffice/tokens.ts` — recover
   `signEditorGrant/verifyEditorGrant/signAiAccessToken/verifyAiAccessToken/bearerToken`
   from `7eed0aa` and note the secret is now `appJwtSecret` (`OO_APP_JWT_SECRET`).
4. **Point the proposal generation at Dora** — the old `ai-service.ts` was a single-shot
   "Clara" prompt on the `reasoning` role; today it should call into `lib/ai/dora/`
   (same grounding as the brief) and return the typed operations the plugin applies.
5. Keep the plugin **headless-ish**: with Dora's panel as the brain, the plugin can shrink
   to an "apply bridge" whose UI is one list of pending operations (or even zero UI, driven
   via `options` refresh on regenerate).

## Path C — the official ONLYOFFICE AI plugin

DS bundles/offers an official AI plugin (Plugin Manager → AI; enable under Background
plugins). It adds an AI tab: text generation, rewriting, summarizing, translation, chat
(Ctrl+/), with providers configured **by each user in the editor UI** (OpenAI, Anthropic,
Gemini, Ollama/LM Studio via base URL, etc.). Docs:
[AI plugin guide](https://api.onlyoffice.com/docs/plugin-and-macros/ai/ai-plugin/),
[quick start](https://helpcenter.onlyoffice.com/ai/gettingstarted/quick-start-guide/ai-quick-start.aspx).

Why it is **not** our product surface: no tender/company grounding, no tenancy or audit,
keys live with the user/browser and calls go straight to the provider, UX is generic. It's
fine as an internal power-user tool; to keep it out of the product entirely, don't install
it (and/or hide plugins via `customization.plugins: false` / `layout` — see
[02](02-ui-customization-and-branding.md)).

## Path D — Automation API (connector)

The clean, supported way to drive the live editor from **our** page — no plugin, full
React UX with live apply:

```js
const connector = docEditor.createConnector();
connector.executeMethod("GetAllComments", null, cb);
connector.callCommand(() => { /* Api.* Office API, same as plugins */ });
connector.attachEvent("onChangeContentControl", cb);
```

Hard gate: *“Automation API is available only for ONLYOFFICE Docs Developer”* (paid;
sales@onlyoffice.com). If the business ever funds it, Dora's suggested values become
one-click applies with ~2 days of work, reusing the operation schema from Path B. Docs:
[Automation API](https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api/).

## Path E — server-side document writing

No editor involved: produce a **new committed version** and let the version system do the
rest (our restore flow already proves the mechanics — new version row + head swap + key
rotation, see [01](01-integration-architecture.md)).

- PDF AcroForm fill: solid with `pdf-lib`.
- DOCX: content-control (`<w:sdt>`) filling via raw OOXML editing is feasible; full body
  rewrites risk fidelity. The `docx` npm package (already a dependency) is
  generation-oriented, not an editor.
- DS `/converter` handles format conversion around this (e.g. produce a PDF of the filled
  DOCX). ONLYOFFICE **Document Builder** (their scriptable headless engine /
  `docbuilder` service) is an alternative for template-driven generation — ⚠ verify its
  availability/licensing on our DS version before designing around it.

Good fit for: "generate the filled Formblatt from company data as a new version", bulk
pre-filling, exports. Combine with Path A: Dora computes the values, a server job writes
them, the editor reloads the new version.
