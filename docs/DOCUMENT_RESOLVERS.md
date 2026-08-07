# Tender Document Resolvers — Coverage & Status

Resolvers turn a tender's portal landing-page URL into downloadable files. This documents
the resolver families, what each one does, and — for the portals we cannot fetch — the
specific reason. Coverage is measured over the live `tender_documents` corpus with
`npm run fetch:documents -- --coverage`.

## Coverage

| | Refs | Share |
|---|---:|---:|
| **Corpus** | 26,267 | 100% |
| **Covered by a platform resolver** (was 39.1% — cosinex + evergabe-online only) | **16,613** | **63.2%** |
| Uncovered (generic fallback) | 9,654 | 36.8% |

### By resolver

| Resolver | Hosts | Refs | Mechanism |
|---|---:|---:|---|
| `cosinex` | 22 | 8,285 | `…Satellite/` path → public `Vergabeunterlagen_<id>.zip` |
| `netserver` | 37 | 3,534 | `/NetServer/` → `_DownloadTenderDocuments` bundle ZIP (public subset) |
| `evergabe-online` | 1 | 1,984 | Federal e-Vergabe; cookie handshake + Wicket `zipDownloadButton` |
| `rib-meinauftrag` | 1 | 1,658 | **Headless render** → `remote/download.php?k=…` per-file links |
| `aumass` | 1 | 711 | `Document/GetDocument?doctype=allfiles` ("ohne Registrierung") |
| `staatsanzeiger` | 2 | 441 | GET choice page → **POST** `DownlAsAnonym` → `.zip` link |

Added this pass: **netserver, aumass, staatsanzeiger, rib-meinauftrag** (+~6,300 refs).

## Capabilities added to the pipeline

- **`DocumentFetcher.post()`** ([http.ts](../lib/ingestion/documents/http.ts)) — form POST reusing the per-host cookie jar, for two-step "choose how to download" flows (staatsanzeiger).
- **Headless browser** ([browser.ts](../lib/ingestion/documents/browser.ts)) — lazy Chromium singleton exposing `render()` (rendered DOM for SPAs) and `capture()` (intercept the documents API a SPA fetches). Gated by `DOCUMENTS_BROWSER_ENABLED`; per-host rate-limited; closed by the CLI scripts on exit. Requires `npx playwright install chromium`.

## Verified end-to-end (download → S3 → unpack → text)

`tender24` (14 MB ZIP → 4 files), `aumass` (→ 16 files), `staatsanzeiger` (→ 29 files),
`rib` (→ 3 PDFs, text extracted). All 0-failure.

## Cannot resolve (yet) — and why

| Host(s) | Refs | Reason |
|---|---:|---|
| **www.evergabe.de** | 2,635 | Free path exists ("Kostenfreier Zugang" → *Vergabeunterlagen ansehen*) but sits behind a JS "Zustellweg auswählen" step that returns a *JavaScript-disabled* wall even under headless (bot-detection/hydration). Needs a browser **click-through** resolver — top future target. |
| **subreport.de / subreport-elvis.de** | 2,032 | ELViS app redirects to `login.html`; the document browser requires a **bidder account**. The public `…/download/…/bekanntmachung.pdf` (notice PDF only) is already fetched by the generic resolver. |
| **deutsche-evergabe** (bieterzugang, www, `bieterportal.noncd.db.de`) | ~2,000 | `/api/…/deeplink/subproject/<uuid>` opens the bidder **portal dashboard**; documents require **login** (closed tenders land on `dashboard_off`). |
| **vergabe24** (bund + www) | 798 | Deep link resolves to a `?token=…` landing with no public document links; documents are behind **login**. |
| **deutsches-ausschreibungsblatt** | 525 | Angular SPA; `/lookup/documents/initiateDownload/<hash>` 308-redirects then **500s** without in-app session state. Underlying tenders are NetServer-backed but not exposed publicly here. |
| NetServer **login-gated** subset (sachsen-vergabe, landbw, hessen, fraunhofer, evergabe.sachsen, vergabekooperation.berlin, …) | (within netserver 3,534) | Same software as the public NetServer portals but the bundle needs a **bidder login** — correctly recorded `LOGIN_REQUIRED` by the resolver rather than mis-fetched. |
| **TED** documents | — | `TED_API_KEY` unset; the adapter uses the public search API, which yields no document URLs. |
| Long tail (~92 hosts) | ~1,300 | Handled by the generic fallback; per-host effort stops paying (avg ~2 refs/host). |

## Running & verifying

```bash
npm run fetch:documents -- --coverage                 # coverage by resolver family
npm run documents:inspect -- <portal-url>             # resolve + HEAD a live URL (no writes)
npm run fetch:documents -- --host <host> --limit 20   # full fetch → S3 → text for one host
npm run fetch:documents -- --status                   # fetched/skip/failure breakdown
```

New resolvers live in [`lib/ingestion/documents/resolvers/`](../lib/ingestion/documents/resolvers/)
and are registered in [`registry.ts`](../lib/ingestion/documents/registry.ts). Reference
portal HTML snapshots are under [`fixtures/portals/`](../fixtures/portals/).
