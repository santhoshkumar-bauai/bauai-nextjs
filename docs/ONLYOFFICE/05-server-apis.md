# 05 — Server-side APIs of the Document Server

Everything our backend can ask the DS to do. All of these are Community-Edition features.
Two rules apply to every call (see `requestConversion()` in
[lib/onlyoffice/conversion.ts](../../lib/onlyoffice/conversion.ts) and
[lib/ai/dora/forcesave.ts](../../lib/ai/dora/forcesave.ts) for the canonical pattern):

1. Sign the JSON body with `OO_JWT_SECRET` and send the JWT **both** as
   `Authorization: Bearer <token>` and as `token` inside the body (`JWT_IN_BODY=true`).
2. Talk to `DS_INTERNAL_URL`, and rewrite any download URL the DS returns through
   `normalizeOnlyOfficeDownloadUrl` before fetching it (SSRF guard).

## 1. Command service — `POST {DS}/command`

(Old deployments: `/coauthoring/CommandService.ashx`; same service. Optional
`?shardkey=<docKey>` for load-balanced clusters.)

| Command | What it does | Our usage |
|---|---|---|
| `forcesave` | Flush the live editing session to a save (status-6 callback) without closing it. Body: `{c:"forcesave", key:<activeEditorKey>, userdata:"…"}` | `forcesaveAndWait()` — Dora's "Analyze latest" freshness |
| `info` | Document status + connected user ids for a key | Handy for debugging "who has it open" |
| `drop` | Force-disconnect users from a key | Admin/unstick tooling |
| `meta` | Update the document title live for all collaborators | Could back our rename flow (currently rename is metadata-only) |
| `version` | DS build version | Ops |
| `license` | License/quota/connection info | Ops (connection-limit monitoring) |
| `getForgottenList` / `getForgotten` / `deleteForgotten` | "Forgotten" files = saves whose callback never succeeded; DS keeps them | Disaster recovery if our callback endpoint was down during a final save |

### Response `error` codes

| Code | Meaning | Our mapping (forcesave) |
|---|---|---|
| 0 | OK (for forcesave: save initiated → expect a status-6 callback) | poll `storageRevision` for the commit |
| 1 | Document key missing/unknown (no live session) | treat as **fresh**, not an error |
| 2 | Wrong callback URL | config bug |
| 3 | Internal DS error | fall back to last committed version |
| 4 | No unsaved changes | treat as **fresh** |
| 5 | Bad command format | code bug |
| 6 | Invalid token | JWT/secret mismatch |

Reference: [Command service docs](https://api.onlyoffice.com/docs/docs-api/additional-api/command-service/).

## 2. Conversion service — `POST {DS}/converter` (+`?shardkey=`)

Body essentials: `{ async, filetype, outputtype, key, title, url }` — `url` must be
fetchable by the DS container (we pass presigned S3 GET URLs). Response:
`{ endConvert, fileUrl, fileType, percent, error }`.

- **Sync vs async:** `async:false` blocks until done (fine for small/interactive jobs —
  Dora's xlsx→csv). `async:true` returns immediately; poll by re-POSTing the **same
  `key`** until `endConvert` (our doc/xls→docx/xlsx worker polls 180×2 s). The key IS the
  conversion's idempotency handle — reuse it to retrieve, change it to redo.
- **Formats we use:** `doc→docx`, `xls→xlsx` (canonicalization on upload), `xlsx→csv`
  (Dora text extraction; **first sheet only**). Also available when needed: anything→`pdf`
  (`pdf.form:true` makes fillable PDFs), `ooxml`/`odf` autodetect targets, image
  `thumbnail`s (first page or per-page), `watermark` stamping, `region` for locale-driven
  number/date rendering, `password` for protected inputs.
- **Limits:** spreadsheets→pdf/images cap at 1 500 pages; long sync conversions can time
  out at the proxy — that's what async+poll is for.

### Error codes (negative)

| Code | Meaning |
|---|---|
| -1 | Unknown error |
| -2 | Conversion timeout |
| -3 | Conversion error |
| -4 | DS could not download the source `url` |
| -5 | Incorrect password (`ERROR_CODES` in conversion.ts → `password_required`) |
| -6 | Database error |
| -7 | Invalid input |
| -8 | Invalid token |
| -9 | Could not auto-detect output format |
| -10 | File too large (`ERROR_CODES` → `file_too_large`) |

Reference: [Conversion API](https://api.onlyoffice.com/docs/docs-api/additional-api/conversion-api/request/).

## 3. Callback handler (DS → us)

Not an API we call, but the other half of every save — fully documented in
[01-integration-architecture.md](01-integration-architecture.md) (status table, JWT +
signed-field verification, version commit, key rotation). One reminder: **always** answer
`{"error":0}`, or DS re-delivers.

## 4. Health & ops endpoints

| Endpoint | Use |
|---|---|
| `GET {DS}/healthcheck` → `true` | Compose healthcheck + uptime monitoring |
| `GET {DS}/` welcome page | Manual smoke test |
| `POST {DS}/command {c:"license"}` | Connection-count vs the 20-connection Community cap |

## 5. Document Builder (adjacent, not wired)

ONLYOFFICE's scriptable document engine: a JS script (`builder.CreateFile("docx")`,
`Api.*` calls, `builder.SaveFile`) produces a file headlessly — template-driven generation
without an editor session. It exists as a standalone open-source engine/lib and as a DS
endpoint on some builds. ⚠ Before designing a feature on it, verify availability on our
pinned DS image and current licensing; for straightforward "fill a form as a new version"
jobs, server-side OOXML/pdf-lib (Path E in [04](04-ai-integration.md)) needs no new
runtime at all.
