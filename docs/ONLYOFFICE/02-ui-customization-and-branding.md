# 02 — UI customization & branding

What we can change about how the editor looks and behaves, with the exact lever for each,
and — just as important — what is structurally impossible.

## Hard truths first

The editor is a **cross-origin iframe rendering to canvas**. From our app we cannot:

- inject CSS or fonts into it,
- query or mutate its DOM,
- add our own buttons to its toolbar from the host page (that requires a plugin
  — [03-plugins.md](03-plugins.md) — or the paid connector),
- restyle it beyond what `customization`, themes and the license allow.

Anything a designer asks for beyond that list is done **around** the iframe (our own
header/panels — see the last section) or requires the Developer Edition / forking
`web-apps` (AGPL obligations apply to a fork).

## Lever 1 — the `customization` object (per-session, in `buildOnlyOfficeConfig`)

Set in [lib/onlyoffice/config.ts](../../lib/onlyoffice/config.ts). What we ship today:

```ts
customization: {
  about: false,        // ⚠ hiding "about" fully is white-label-licensed; harmless to request
  autosave: true,
  chat: false,         // we have our own collaboration surfaces
  comments: true,
  compactHeader: true, // logo+menu collapse into one row — key to our slim look
  forcesave: true,     // Ctrl+S produces a status-6 callback (a real committed version)
  help: false,
  spellcheck: true,
}
```

### Standard branding — available on Community (all editions)

Per the [official list](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/customization/customization-standard-branding/):

| Param | What it does |
|---|---|
| `anonymous` | Ask-name dialog for anonymous users (`request`, `label`) |
| `autosave`, `forcesave` | Autosave toggle; Ctrl+S → forcesave callback |
| `chat`, `comments`, `help`, `hideNotes`, `hideRulers`, `hideRightMenu` | Feature/panel visibility |
| `close` | Show a close button in the header (`visible`, `text`) — pairs with `events.onRequestClose` |
| `compactHeader`, `compactToolbar`, `toolbarNoTabs`, `toolbarHideFileName` | Density/chrome reduction |
| `compatibleFeatures` | Legacy behavior switches |
| `features` | `featuresTips`, `spellcheck` (initial state), `tabBackground`, `tabStyle` |
| `feedback` | Feedback link (`url`, `visible`) |
| `goback` | The back link in the header (`url`, `text`, `blank`) — we don't use it; our own header has Back |
| `integrationMode: "embed"` | Drops outer paddings for tight embedding |
| `layout` | Toggle whole regions: `header` (parts), `leftMenu`, `rightMenu`, `statusBar`, `toolbar` (per-tab!) — e.g. hide the Plugins tab or the entire right menu |
| `logo` ⚠ | `image`, `imageDark`, `imageLight`, `url`, `visible` — replaces the in-editor logo. Currently listed as standard branding; historically license-gated. **Test on our pinned DS before promising.** |
| `macros`, `macrosMode` | Allow macros; `"warn" | "enable" | "disable"` |
| `mentionShare`, `mobile`, `pointerMode`, `showHorizontalScroll`, `showVerticalScroll` | Misc behavior |
| `plugins: false` | Hide the whole plugin system from users (we leave it on) |
| `review` | `trackChanges` initial state, `reviewDisplay`, `showReviewChanges`, `hoverMode` |
| `uiTheme` | Initial theme id — see Lever 2 |
| `unit` (`cm/pt/inch`), `zoom` (percent, `-1` fit-page, `-2` fit-width) | Defaults |
| `submitForm` | Submit button behavior in form documents |
| `wordHeadingsColor`, `slidePlayerBackground` | Accent colors |

### Developer-Edition-only

- `customization.customer` (About-panel company block), `features.roles`.

### Extended white-label license only

Per the [white-label page](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/customization/customization-white-label/):
`about` (fully removing it), `font` (editor UI font), the deep `layout` variants,
`loaderLogo`, `loaderName`. Quote from the docs: *“The parameters on this page are
available only for the extended white label license of ONLYOFFICE Docs Developer.”*
Contact sales@onlyoffice.com if the product ever needs true white-label.

### Also part of the config (not `customization`)

- `document.permissions` — we set `chat:false, comment, copy, download, edit, fillForms,
  modifyContentControl, modifyFilter, print, review` per document. Permissions remove UI
  *and* capability (e.g. `edit:false` + `fillForms:true` = form-filling mode).
- `editorConfig.lang` — editor UI language; we map our locale (`de`/`en`).
- `editorConfig.region` — number/date locale.
- `type: "desktop" | "mobile" | "embedded"` — `embedded` is the minimal read-only chrome.
- `events` — host-page hooks (`onDocumentStateChange`, `onRequestClose`,
  `onRequestHistory`, `onError`, `onWarning` …). We currently only track ready-state in
  `editor-client.tsx`; wiring `onError` into telemetry is cheap and worth doing.

**Editing note:** any `customization` change is per-session config — deploy the app, no DS
change needed. The config is JWT-signed, so users cannot self-upgrade permissions.

## Lever 2 — interface themes (our strongest Community-safe branding lever)

Built-in ids: `theme-light`, `theme-classic-light`, `theme-dark`, `theme-contrast-dark`
(plus OS-following defaults). Set the initial one via `customization.uiTheme`; users can
switch unless you pin it.

**Custom theme (DS 7.0+):** a JSON file on the Document Server:

1. Author `bau-theme.json`:

```json
{
  "name": "BAU AI",
  "id": "theme-bau",
  "type": "light",
  "colors": {
    "toolbar-header-document":   "#1B1B33",
    "toolbar-header-spreadsheet":"#1B1B33",
    "toolbar-header-presentation":"#1B1B33",
    "toolbar-header-pdf":        "#1B1B33",
    "text-toolbar-header-on-background-document": "#FFFFFF",
    "background-toolbar": "#F7F7FA",
    "highlight-button-pressed": "#6B4EFF",
    "...": "see the built-in themes for the full ~100-key palette"
  }
}
```

2. Deploy it into the container at
   `/var/www/onlyoffice/documentserver/web-apps/apps/common/main/resources/themes/`
   — for us: a bind-mount/volume in `docker/onlyoffice/docker-compose.yml` (keeps the
   stock image stock), then restart the container.
3. Reference it: `customization.uiTheme: "theme-bau"` in `buildOnlyOfficeConfig`.

Crib the full key list from an existing theme file in that same directory. Browser caches
the theme CSS aggressively — bump/refresh after edits. Sources:
[helpcenter guide](https://helpcenter.onlyoffice.com/docs/installation/docs-developer-change-theme.aspx),
[themes config](https://api.onlyoffice.com/docs/docs-api/get-started/how-it-works/customizing-themes.md).

## Lever 3 — around-the-iframe UI (what we actually do)

Our brand lives in the chrome **we** render, which needs no license and no DS changes:

- [components/onlyoffice/editor-workspace.tsx](../../components/onlyoffice/editor-workspace.tsx)
  — our header (logo, filename, state, download, version history, Dora toggle) above a
  flex row of editor + [Dora panel](../../components/dora/dora-panel.tsx).
- `compactHeader: true` + `help/about/chat: false` shrink ONLYOFFICE's own chrome so ours
  reads as *the* UI.
- The pattern generalizes: toolbars, status strips, review sidebars — build them in React
  next to the iframe and talk to our APIs, not to the editor.

## Recipe book

| Ask | Answer |
|---|---|
| "Make the editor match our colors" | Custom theme JSON (Lever 2) + `uiTheme` |
| "Remove the ONLYOFFICE logo" | `customization.logo` ⚠ (test on 9.4.0); full removal of About = white-label license |
| "Hide the Plugins tab / right panel / status bar" | `customization.layout` / `hideRightMenu` / `plugins:false` |
| "Read-only preview embed" | `type:"embedded"` + `permissions.edit:false` (`integrationMode:"embed"`) |
| "Form-filling only" | `permissions: { edit:false, fillForms:true }` |
| "Add our own button INSIDE the toolbar" | Not from the host page. Plugin ([03](03-plugins.md)) or Developer-Edition connector ([04](04-ai-integration.md)) |
| "German editor UI" | `editorConfig.lang` (already wired from our locale) |
| "Custom fonts in the editor UI" | White-label license only. (Document *content* fonts: install fonts into the DS image + `documentserver-generate-allfonts.sh` — separate topic) |
