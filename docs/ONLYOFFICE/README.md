# ONLYOFFICE at BAU AI — developer guide

This folder is the go-to reference for everything ONLYOFFICE in this codebase: how our
integration is wired, what can (and cannot) be customized in the editor UI, how to brand
it, every route into AI, and the Document Server's server-side APIs.

> Verified against **ONLYOFFICE Docs 9.4.0** (the version we pin) and the official docs at
> [api.onlyoffice.com](https://api.onlyoffice.com/docs/docs-api/) in August 2026. When the
> pinned version changes, re-verify anything marked ⚠.

## The one mental model that explains everything

```
┌─ BAU AI Next.js app (localhost:3000 / app.example.com) ────────────────────┐
│                                                                            │
│  Our React UI (header, Dora panel, version drawer …)   ← full control      │
│  ┌─ <iframe> Document Server origin (docs.example.com) ────────────┐       │
│  │                                                                 │       │
│  │   The editor. Canvas-rendered, CROSS-ORIGIN, sealed.            │       │
│  │   We cannot inject CSS/JS or touch its DOM. Ever.               │       │
│  │                                                                 │       │
│  │   Influence from outside, in order of power:                    │       │
│  │    1. the signed config object at init (customization, perms)   │       │
│  │    2. plugins running INSIDE the editor (our code, DS-hosted)   │       │
│  │    3. the Automation API "connector" (paid Developer Edition)   │       │
│  │    4. server-side theme JSON files on the DS container          │       │
│  └─────────────────────────────────────────────────────────────────┘       │
│                                                                            │
│  Server ↔ server: callbacks, /command (forcesave…), /converter, JWT        │
└────────────────────────────────────────────────────────────────────────────┘
```

Everything in these docs is one of those levers. If someone asks "can we change X in the
editor?", the answer is always: *which lever reaches X?*

## I want to… → read

| Goal | Doc |
|---|---|
| Understand how our editor integration works end-to-end (config, callbacks, versions, S3) | [01-integration-architecture.md](01-integration-architecture.md) |
| Hide/show editor UI parts, set themes, match our branding, know what's impossible | [02-ui-customization-and-branding.md](02-ui-customization-and-branding.md) |
| Build something that runs *inside* the editor (buttons, panels, doc manipulation) | [03-plugins.md](03-plugins.md) |
| Add or change AI in/around the editor (Dora, in-editor apply, official AI plugin, connector) | [04-ai-integration.md](04-ai-integration.md) |
| Call Document Server from our backend (forcesave, conversion, info, health) | [05-server-apis.md](05-server-apis.md) |

## Edition cheat-sheet (what our money buys)

We run **Community Edition** (AGPL, self-hosted, pinned `onlyoffice/documentserver:9.4.0`).

| Capability | Community (us) | Developer Edition (paid) |
|---|---|---|
| Full editing, co-editing, callbacks, versioning | ✅ | ✅ |
| `/command` service (forcesave, info, drop…) | ✅ | ✅ |
| `/converter` service | ✅ | ✅ |
| Plugins (custom + marketplace) | ✅ | ✅ |
| Standard-branding `customization` params (incl. `logo` ⚠, `uiTheme`, layout toggles) | ✅ | ✅ |
| Custom interface themes (server-side JSON) | ✅ | ✅ |
| `customization.customer`, `features.roles` | ❌ | ✅ |
| White-label params (`about`, `font`, deep `layout`, `loaderLogo`, `loaderName`) | ❌ | ✅ (extended white-label license) |
| **Automation API / connector** (drive the editor from our page JS) | ❌ | ✅ |
| Connection limit | 20 simultaneous | per license |

⚠ The docs currently list `logo` under standard branding; older versions gated it. Test
against the deployed DS version before promising it. Sources:
[standard branding](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/customization/customization-standard-branding/),
[white label](https://api.onlyoffice.com/docs/docs-api/usage-api/config/editor/customization/customization-white-label/).

## History in one paragraph

The editor integration shipped in commit `7eed0aa` together with an **in-editor AI plugin**
("Clara", a sdkjs plugin baked into a custom DS image). In commit `3e4ae5e` (11 Aug 2026)
that plugin was removed — we returned to the stock DS image — and AI moved to **Dora**, a
React side panel *outside* the iframe (`components/dora/`, `lib/ai/dora/`), grounded in our
own retrieval stack. The plugin's full source remains readable at
`git show 7eed0aa:docker/onlyoffice/plugin/plugin.js` and is documented as a case study in
[03-plugins.md](03-plugins.md) — it is the reference implementation if in-editor apply ever
comes back.
