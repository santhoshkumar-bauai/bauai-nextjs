# 01 — Our integration architecture

How a document goes from S3 to an editable editor tab and back. Read this before touching
anything under `lib/onlyoffice/` or `app/api/onlyoffice/`.

## Module map

| File | Role |
|---|---|
| `lib/onlyoffice/env.ts` | All env reads; `onlyOfficeEnabled()`; `appJwtSecret()` (reads `OO_APP_JWT_SECRET`, falls back to legacy `OO_AI_JWT_SECRET` — **never delete the fallback** while deployments still set the old name) |
| `lib/onlyoffice/tokens.ts` | `signOnlyOfficeConfig` (HS256, `OO_JWT_SECRET`, shared with DS) · `signUploadToken`/`verifyUploadToken` (app-internal upload grants, `OO_APP_JWT_SECRET`) |
| `lib/onlyoffice/config.ts` | `buildOnlyOfficeConfig()` — the signed editor config (see below) |
| `lib/onlyoffice/callback.ts` | Callback JWT verification + signed-field tamper check, SSRF-guarded URL rewrite (`normalizeOnlyOfficeDownloadUrl`), and the save/version commit state machine |
| `lib/onlyoffice/key.ts` | Editor key format `bau-<env>-<docId>-r<editorRevision>`; the revision (and therefore the key) rotates **only** on callback status 2 — key stability is what keeps co-editing sessions alive |
| `lib/onlyoffice/formats.ts` | Format table: `docx`/`xlsx`/`pdf` native; `doc`/`xls` accepted then converted; `pptx` rejected; 100 MB cap; `WORKSPACE_ACCEPT` for the file input |
| `lib/onlyoffice/conversion.ts` | `convertWorkspaceDocument()` (doc→docx, xls→xlsx via `/converter`) + exported `requestConversion()` used by Dora's xlsx→csv text extraction |
| `lib/onlyoffice/document-service.ts` | Creates a `WorkspaceDocument` + v1 version from an S3 object |
| `lib/onlyoffice/storage.ts` | S3 key layout (`incoming/`, `pending/`, `versions/`), streaming hash+upload, pending→final promotion |
| `lib/onlyoffice/queue.ts` | BullMQ `onlyoffice-conversion` queue, prefix `{bauai:onlyoffice}` |
| `lib/onlyoffice/reconcile.ts` | Repairs interrupted commits, GCs orphan versions, re-enqueues stuck conversions (runs every 60 s in the worker) |
| `lib/onlyoffice/serialize.ts` | Client-safe DTOs |
| `workers/onlyoffice.mts` | The conversion worker + reconcile loop (`npm run worker:onlyoffice`, exactly one instance) |
| `models/workspace-document.ts` | Head record: `state` machine (`uploading→converting→ready`, `conversion_failed`, `save_failed`, `deleting`), `currentVersionId`, `editorRevision`, `storageRevision`, `activeEditorKey`, `activeUserIds`, optional `tenderId` + `source` |
| `models/workspace-document-version.ts` | Immutable versions: `s3Key`, `sha256`, `reason` (`upload/conversion/forcesave/final/restore`), `state` (`pending/committed/orphan`) |

UI: `app/(workspace)/document-filler/` (library + editor pages),
`components/onlyoffice/document-library.tsx`, `editor-workspace.tsx` (header + editor +
Dora panel layout), `editor-client.tsx` (mounts `@onlyoffice/document-editor-react`'s
`DocumentEditor`, `ssr:false`, destroys via `window.DocEditor.instances[id].destroyEditor()`).

## The open flow

```
/document-filler/[documentId]  (server page: session + ownership check)
  └─ EditorWorkspace → OnlyOfficeEditorClient
       └─ GET /api/onlyoffice/config/[documentId]        (409 unless state === "ready")
            └─ buildOnlyOfficeConfig()
                 ├─ current committed WorkspaceDocumentVersion
                 ├─ presigned S3 GET (1 h) → config.document.url
                 ├─ key = document.activeEditorKey
                 ├─ callbackUrl = ${INTERNAL_APP_URL}/api/onlyoffice/callback/{id}
                 └─ signOnlyOfficeConfig(...) → config.token
       └─ <DocumentEditor documentServerUrl={NEXT_PUBLIC_DS_URL} config={...}/>
            └─ browser loads DS api.js → DS fetches the presigned URL → editor opens
```

Second entry point: tender detail → `POST /api/tenders/[id]/documents/working-copy` copies
the tender's S3 object server-side (`copyObject`, bytes never touch the client) into a new
workspace document, then redirects into the editor.

## The save flow (callback state machine)

DS POSTs to `/api/onlyoffice/callback/[documentId]`; `lib/onlyoffice/callback.ts` verifies
the JWT **and** checks the signed fields match the body (tamper check), then:

| Callback `status` | Meaning | What we do |
|---|---|---|
| 1 | Session roster changed | Update `activeUserIds` |
| 4 | Everyone closed, no changes | Clear roster |
| 2 | Everyone closed, WITH changes (final save) | Download from DS (URL rewritten to `DS_INTERNAL_URL`, SSRF-guarded) → S3 `pending/` → promote to `versions/` → new committed `WorkspaceDocumentVersion` → head update → **rotate `editorRevision` + `activeEditorKey`** |
| 6 | Force save (autosave interval, our `/command` forcesave, or Ctrl+S with `forcesave:true`) | Same commit path, but the key does NOT rotate (session continues) |
| 3 / 7 | Save error / force-save error | `state = "save_failed"` (+ reconcile picks it up) |

Always answer `{"error": 0}` on success — anything else makes DS retry.

**Key rotation semantics** (the part people break): the editor key identifies a co-editing
session and its cache. Reusing a key after the bytes changed = users silently editing a
stale cached copy. Rotating it mid-session = kicking everyone out. Hence: rotate on status
2 only; forcesave (6) keeps the key. `reconcile.ts` exists because a crash between
"downloaded from DS" and "head updated" must not lose the bytes or duplicate versions.

## Env vars

| Var | Meaning |
|---|---|
| `NEXT_PUBLIC_DS_URL` | Browser-facing DS origin (baked into the web image at build; also in the CSP `frame-src`, see `next.config.ts`) |
| `DS_INTERNAL_URL` | Server→DS URL (converter, `/command`, callback download rewrite) |
| `INTERNAL_APP_URL` | Our origin as DS reaches it for callbacks (`host.docker.internal:3000` in local dev) |
| `PUBLIC_APP_URL` | Our public origin |
| `OO_JWT_SECRET` | Shared with the DS container (`JWT_SECRET`); signs the editor config, callbacks, converter and command requests |
| `OO_APP_JWT_SECRET` | App-internal (upload grants). Legacy name `OO_AI_JWT_SECRET` still honored via fallback |
| `ONLYOFFICE_ENABLED` | Feature flag for the whole surface |
| `S3_WORKSPACE_DOCUMENT_PREFIX` | Bucket prefix (`workspace-documents`) |
| `ONLYOFFICE_CONVERSION_CONCURRENCY`, `ONLYOFFICE_REDIS_PREFIX` | Worker tuning |

## Deployment

- **Image:** stock `onlyoffice/documentserver:9.4.0` (no custom build since `3e4ae5e`).
  Compose files: `docker/onlyoffice/docker-compose.yml` (local/dokploy),
  `deploy/docker-compose.onlyoffice.yml` (prod). Ops runbook: `deploy/README-onlyoffice.md`.
- DS env we set: `JWT_ENABLED=true`, `JWT_SECRET=$OO_JWT_SECRET`, `JWT_HEADER=Authorization`,
  `JWT_IN_BODY=true`, `ALLOW_PRIVATE_IP_ADDRESS=true` (presigned URLs may resolve private),
  `LARGER_FILE_LIMITS=true`.
- Local dev: DS on `http://localhost:8080`, app on 3000, `INTERNAL_APP_URL=http://host.docker.internal:3000`.
- Health: `GET {DS}/healthcheck` → `true`.
- One `workers/onlyoffice.mts` instance must always run in prod (conversions + reconcile).

## Invariants (do not break)

1. Tenant scope comes from `getCompanyContext()`; every route filters
   `companyId + deletedAt: null`. Document ids are never trusted alone.
2. `config.document.key` comes only from `activeEditorKey`; never invent keys.
3. Committed versions are immutable; new bytes = new version row + head swap.
4. All server→DS calls carry the JWT in **both** the `Authorization` header and the body
   (`JWT_IN_BODY=true`); see `requestConversion()` / `lib/ai/dora/forcesave.ts` for the
   canonical pattern.
5. Download URLs from callbacks/converter are rewritten through
   `normalizeOnlyOfficeDownloadUrl` before fetching — never fetch them raw (SSRF).
