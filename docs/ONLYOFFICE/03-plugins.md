# 03 — Plugins (running our code INSIDE the editor)

Plugins are the only Community-Edition way to put custom UI and logic *inside* the editor:
toolbar buttons, side panels, and programmatic document manipulation with the user's live,
unsaved state. We shipped one (the Clara AI plugin, commit `7eed0aa`), removed it
(`3e4ae5e`) in favor of the Dora panel, and keep it documented here as the reference
implementation.

## Anatomy

A plugin is a folder of static files served by the Document Server (or any CORS-open host):

```
my-plugin/
  config.json     ← manifest (identity + how/where it runs)
  index.html      ← the panel/dialog markup; loads ../v1/plugins.js (the DS plugin SDK)
  plugin.js       ← logic against window.Asc.plugin
  styles.css
```

### config.json (manifest) — our real one

`git show 7eed0aa:docker/onlyoffice/plugin/config.json`:

```json
{
  "name": "Clara — BAU AI",
  "guid": "asc.{A6F63B3B-0B0D-4A44-8F54-BA0A10000001}",
  "version": "1.0.0",
  "baseUrl": "",
  "variations": [{
    "description": "Reviewable tender-document assistance from Clara",
    "url": "index.html",
    "isViewer": false,
    "EditorsSupport": ["word", "cell", "pdf"],
    "isVisual": true,
    "isModal": false,
    "isInsideMode": true,
    "initDataType": "none",
    "initData": "",
    "buttons": []
  }]
}
```

Field notes (full reference:
[api.onlyoffice.com → Plugin and macros → Structure](https://api.onlyoffice.com/docs/plugin-and-macros/)):

| Field | Meaning |
|---|---|
| `guid` | Must be `asc.{UUID}` — the editor's registry key. Also the key under which per-session `options` arrive |
| `variations[].url` | Entry html, relative to the plugin folder |
| `EditorsSupport` | `"word" | "cell" | "slide" | "pdf"` — where it appears |
| `isVisual` | Has UI (false = background service plugin) |
| `isModal` + `isVisual` | Dialog window; **`isInsideMode: true`** = docked right-panel (what we used) |
| `isSystem` | Starts with the editor, no user action (for background/autostart-style plugins) |
| `isViewer` | Also available in view mode |
| `initDataType`/`initData` | `none/text/html/ole` — payload handed to the plugin on start |
| `buttons` | For modal variations: the dialog's footer buttons |

### The runtime API (inside `plugin.js`)

Three call families — all visible in our recovered plugin
(`git show 7eed0aa:docker/onlyoffice/plugin/plugin.js`):

1. **Lifecycle** — `window.Asc.plugin.init = fn` (start; receives `initData`),
   `window.Asc.plugin.button = fn` (modal buttons / close),
   `window.Asc.plugin.executeCommand("close", "")`,
   `window.Asc.plugin.info` (`editorType`, `options`, lang…).

2. **`executeMethod(name, args, callback)`** — curated editor methods. Ones we used:
   `GetSelectedText`, `AddComment`, `ReplaceTextSmart`, `SetFormValue` (pdf forms).
   Others worth knowing: `PasteHtml`, `PasteText`, `InputText`, `GetAllForms`,
   `GetAllComments`, `MoveCursorToStart`, `AddToolbarMenuItem` (7.6+ — plugins can add
   real toolbar buttons/tabs).

3. **`callCommand(fn, isClose, isCalc, callback)`** — serializes `fn` into the editor's
   scripting sandbox where the full **Office JS API** (`Api.*`) exists. The function does
   NOT close over your variables — pass data via `Asc.scope`:

```js
Asc.scope.formKey = "field_1"; Asc.scope.formValue = "Wirl Ingenieure GmbH";
window.Asc.plugin.callCommand(function () {
  Api.GetDocument().SetFormsData([{ key: Asc.scope.formKey, value: Asc.scope.formValue }]);
}, false, true, done);
```

   Office API calls we used per editor type:
   - word: `Api.GetDocument().GetFormsData()/SetFormsData()`,
     `SetAssistantTrackRevisions(true, "Clara")` (attribute changes to an assistant, then
     switch back — the reviewable-AI trick), `ReplaceTextSmart` via executeMethod
   - cell: `Api.GetActiveSheet()`, `Api.GetSelection()`, `.GetAddress()/.GetValue()`,
     `.GetRange(addr).SetValue(v)`
   - pdf: `SetFormValue` via executeMethod

**Sandboxing:** the plugin iframe lives on the DS origin, inside the editor. It cannot see
our app's page or cookies. Network calls from it are plain `fetch` subject to CORS — our
gateway answered with `Access-Control-Allow-Origin: <DS origin>` only.

## Deployment options (self-hosted DS)

From [the install guide](https://api.onlyoffice.com/plugin/installation/onpremises):

| Method | How | Notes |
|---|---|---|
| Bake into the image | `COPY plugin/ /var/www/onlyoffice/documentserver/sdkjs-plugins/<name>/` in a Dockerfile | What `7eed0aa` did (`bau-ai/onlyoffice-documentserver:9.4.0-plugin-v1`). Deterministic, but you now own a custom image |
| Volume mount | `-v ./plugin:/var/www/onlyoffice/documentserver/sdkjs-plugins/<name>` | Best for local plugin dev against the stock image |
| CLI manager (7.4+) | `documentserver-pluginsmanager.sh --install=<name>` | Marketplace plugins, system-wide |
| Plugin Manager UI (7.2+) | Plugins tab → Plugin Manager | Per-user, marketplace |
| **Config-based** | `editorConfig.plugins.pluginsData: ["https://…/config.json"]` | No DS change at all; plugin served from any CORS-open host. Config wins over folder copies |

### Per-session activation from our config (how we wired it)

The removed block in `buildOnlyOfficeConfig` (see `git show 7eed0aa:lib/onlyoffice/config.ts`):

```ts
editorConfig: {
  plugins: {
    autostart: [GUID],                                   // open on load
    // Served from the DS origin because the plugin was baked into the image;
    // a pluginsData-only deployment would point at our own host instead.
    pluginsData: [`${NEXT_PUBLIC_DS_URL}/sdkjs-plugins/bau-ai/config.json`],
    options: { [GUID]: { editorGrant, documentId, gatewayUrl, locale } },  // per-session payload
  },
}
```

`options` is the only sanctioned way to pass per-user/per-document data in; the plugin
reads it from `window.Asc.plugin.info.options[guid]`.

## Case study — the removed Clara AI plugin (design worth keeping)

Everything below still reads cleanly from `7eed0aa` and should be copied, not reinvented,
if in-editor apply returns:

1. **Auth = short-lived grant exchange.** The signed config carried an 8 h `editorGrant`
   (audience `onlyoffice-plugin-exchange`); the plugin exchanged it at
   `POST /api/onlyoffice/ai/token` for a 15 min bearer (audience `onlyoffice-ai`), and the
   exchange re-validated membership + document ownership against Mongo. CORS locked to the
   DS origin. (Token fns were in `lib/onlyoffice/tokens.ts`, route in
   `app/api/onlyoffice/ai/token/route.ts`.)
2. **Optimistic-concurrency apply.** Every proposal targeted a SHA-256
   (`expectedHash`) of the text/form/cell it was computed from; before applying, the
   plugin re-read the target and **skipped** any operation whose hash drifted — a
   co-editor can never be silently overwritten.
3. **Reviewable writes.** Word edits ran inside
   `SetAssistantTrackRevisions(true, "Clara")` so every AI change landed as a tracked
   revision attributed to "Clara", accept/reject-able like a human reviewer's.
4. **Structured ops, never freeform.** The server returned typed operations
   (`replace | setForm | setCell | comment` with target kind + rationale + confidence);
   the plugin was a dumb applier with checkboxes.

Why it was removed anyway: the panel UX was a cramped vanilla-JS iframe, it required a
custom DS image, and the AI surface moved to Dora where we control UX/streaming/grounding
fully ([04-ai-integration.md](04-ai-integration.md) has the resurrection guide).

## Macros (the lightweight cousin)

Users can write/record macros (Plugins tab → Macros) — same `Api.*` Office API, stored in
the document, no deployment. `customization.macros`/`macrosMode` (`warn|enable|disable`)
control availability. Fine for power users; not a product surface (no auth, no server
access, per-document).
