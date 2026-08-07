# Tender Ingestion Workers

Implementation of `MONGODB_TENDER_SEEDING_AND_INGESTION_ARCHITECTURE.md`. MongoDB is
the only tender database; Redis is durable work transport; S3 holds raw payloads.

## What runs

| Worker | Entry point | Replicas | Responsibility |
| --- | --- | --- | --- |
| Scheduler | `workers/scheduler.mts` | 1 | Live discovery and nightly reconciliation per source, with MongoDB leases |
| Ingest | `workers/ingest.mts` | N | Fetch, parse, store, and commit notices; expand backfill partitions |
| Outbox relay | `workers/outbox-relay.mts` | 1 | Change stream on `outbox_events` → Redis pub/sub → app |
| Status updater | `workers/status-updater.mts` | 1 | Deadline transitions to `CLOSING_SOON` / `CLOSED` every 5 minutes |

```bash
docker compose -f docker/docker-compose.yml up -d --build
```

```bash
docker compose -f docker/docker-compose.yml up -d --scale ingest=4
```

## Corrections to the architecture document

Two things in `MONGODB_TENDER_SEEDING_AND_INGESTION_ARCHITECTURE.md` cannot be
implemented as written. Both were found by running the code, not by reading it.

**Section 12's geo index is invalid.** The document specifies:

```js
db.tenders.createIndex({ countries: 1, regions: 1, status: 1 })
```

MongoDB cannot index two array fields in one compound index. The index *creates*
successfully and then rejects documents at insert time with
`cannot index parallel arrays [regions] [countries]` (error 171) — so this would
have passed a migration and failed in production on the first multi-country tender.
It is split into `{ countries, status, submissionDeadline }` and
`{ regions, status, submissionDeadline }`, which serve the same filters.

**Section 4's German polling interval is not achievable.** See deviation 3 below.

## Three deliberate deviations from the architecture document

**1. Redis Streams, not Redis pub/sub, for the work queue.** Section 5.1 requires
at-least-once delivery, visibility timeouts, heartbeat extension, and safe
redelivery. Plain pub/sub is fire-and-forget: a job delivered to a worker that then
crashes is gone. Redis Streams consumer groups provide all four through the
pending-entries list. Pub/sub *is* used for the outbox fan-out, where it is correct
— the authoritative record stays in `outbox_events`, so a missed message costs a
push, not data.

**2. S3 instead of GridFS for raw payloads.** Section 6.9 specifies GridFS; this
deployment already has an S3-compatible bucket. The contract that matters is
unchanged: neither participates in a MongoDB transaction, so the payload is
uploaded and checksum-verified first, only a reference goes into the transaction,
and a sweeper deletes uploads whose transaction never committed.

**3. Germany cannot be polled for "today".** Verified 2026-08-05: the official API
rejects the current day —

```
GET /api/notice-exports?pubDay=<today>
400 The specified pubDay exceeds the allowed range. It must lie in the past.
```

The current month's `pubMonth` export ends at yesterday too, and the OpenAPI
document exposes no incremental parameter (only `pubMonth`, `pubDay`, `format`). So
section 4's "check the current `pubDay` every 5 minutes" is not achievable. Live
polling watches **yesterday and the day before** with conditional requests; the
`ETag` (`version-<n>`) changes as yesterday's archive is amended during the day, so
5-minute polling still surfaces notices as early as the source permits.

Consequence for the section 15.1 SLO: **Germany cannot meet a 5-minute
publication-to-app latency.** Its SLO must be measured from source *availability*,
and the source itself lags roughly a day. TED, whose Search API is genuinely
near-real-time, does meet it. Advertise accordingly.

## Verified source behaviour

Both sources were exercised against production endpoints on 2026-08-05.

### Germany — oeffentlichevergabe.de

- `GET /api/notice-exports?pubDay=YYYY-MM-DD` or `?pubMonth=YYYY-MM`
- Requires `Accept: application/vnd.bekanntmachungsservice.eforms.zip+zip`;
  answers **406** with the acceptable representations listed if omitted
- Returns a ZIP of one eForms UBL XML per notice, named
  `<notice-uuid>-<version>.xml`, which supplies notice id and version without
  parsing
- Supports `ETag`; `Cache-Control: max-age=120`
- Licence: `dl-de-by-2.0`

### TED — api.ted.europa.eu

- `POST /v3/notices/search` is **public, no credentials**
- `fields` is mandatory; one unsupported name fails the whole request
- Pages are bounded by `limit x fields`, not `limit`:
  `SEARCH_FIELDS_PER_PAGE_EXCEEDS_MAX_LIMIT`, max 10,000. The adapter derives its
  page size from the field count, so adding a field cannot silently break it
- Sorting goes **inside the query string**: `... SORT BY publication-date DESC`.
  There is no `sortField` parameter
- `paginationMode: "ITERATION"` with `iterationNextToken` is how to page past the
  15,000-result page-number limit
- `GET /v3/notices/{publicationNumber}` requires an API key — five path variants all
  answered `400 Missing Authorization header` — and the `ted.europa.eu/.../xml` web
  URLs sit behind a bot challenge. Without `TED_API_KEY` the search response is the raw
  payload of record; parsed notices carry a `ted-search-projection` warning to say so
- **Document links need no API key.** `document-url-lot` and `document-restricted-lot`
  are returned by the anonymous Search API. Measured 2026-08-05: **30 of 60 notices
  (50%)** carried a document URL, across Spanish, Polish, Latvian, Czech and Swedish
  platforms. An earlier revision of this document claimed document links existed only
  in the key-protected per-notice XML; that was wrong
- Licence: EU reuse decision `2011/833/EU`

**What an API key would add** (it is not needed for anything above): the full eForms
XML per notice, and therefore the richer structured fields the German path already
enjoys — per-lot document metadata with language and type, complete award detail, and
the shared `eforms/parse-notice.ts` mapping instead of the search projection. Obtain one
free from the [TED Developer Portal](https://developer.ted.europa.eu/) with an EU Login;
one active key per account, valid two years, and it cannot be retrieved after creation.

## Notice classification

All 21 eForms notice type codes are mapped in
`lib/ingestion/eforms/notice-types.ts` per section 7. An unrecognised code is
stored verbatim and categorised `UNKNOWN` rather than guessed — a rising unknown
rate is the signal that a new official type appeared.

Validated against a real publication day (853 German notices, 2026-08-04): all 853
parsed, 0 failures, types `cn-standard` 488, `can-standard` 300, `can-modif` 48,
`cn-social` 6, `can-desg` 3, `pin-only` 3, `pin-rtl` 2, `veat` 2, `can-social` 1.

Deadlines: open procedures publish `TenderSubmissionDeadlinePeriod`, while
restricted and negotiated procedures publish only
`ParticipationRequestReceptionPeriod` — the real deadline for them. Both are read,
and `deadlineKind` records which, so the UI never labels one as the other.

## Idempotency

Durable identity is `source + sourceNoticeId + versionKey`, enforced by a unique
index rather than application logic. Four layers, cheapest first:

1. Redis dedupe on the stable job key — an overlap window costs nothing
2. Content-hash comparison before parsing — an unchanged republication stops early
3. `$setOnInsert` against the unique index — concurrent delivery inserts once
4. Optimistic concurrency on `tenders.aggregateVersion` plus a unique
   `aggregateId + aggregateVersion + eventType` outbox index — a losing writer
   retries the whole transaction instead of clobbering

Where a source supplies no version, the version key is derived from the version id
plus a content-hash prefix, so a silent correction republished under the same
version number is still treated as a new immutable version.

## Cross-source linking

`canonicalKey` identifies a *procedure*, not a notice, so a contract notice and its
later award converge on one `tenders` document. Only strong identifiers are used
(section 8.2):

- a globally unique eForms procedure identifier (BT-04) → `proc:<uuid>`, which is
  the same value nationally and on TED, so the two link automatically
- a locally unique procedure id → `proc:<SOURCE>:<id>`, scoped to its source
- otherwise → `ojs:<publication-number>` or `notice:<SOURCE>:<id>`

Title, buyer, and value similarity never merge records. Separate aggregates are
always preferred over a false merge.

## Seeding historical tenders

`npm run seed:tenders` loads history straight into MongoDB. It needs **no Redis and
no Docker**: there is no discovery latency to hide and no live traffic to yield to
during a seed, so the pipeline runs in-process. Everything after discovery is the
same code the workers use — `processNoticeJob` and the transactional writer — so a
seeded tender is identical to one live ingestion would have produced.

```bash
npm run seed:tenders -- --dry-run
```

```bash
npm run seed:tenders
```

Defaults to every notice published in 2026 from every enabled source. Measured on
2026-08-05: TED holds **543,717** notices for 2026 (~70–85k per month, August
partial), plus roughly 2,000–5,000 per German monthly archive.

| Flag | Meaning |
| --- | --- |
| `--year 2026` | Publication year. Default `2026` |
| `--from` / `--to` | Explicit `YYYY-MM-DD` window; `--to` is exclusive |
| `--limit N` | Stop after N notices. `0` or omitted means uncapped |
| `--source DE_BUND` | One source instead of all enabled |
| `--concurrency 16` | Notices processed in parallel. Default 8 |
| `--rate 60` | Override requests/minute for this run only |
| `--status` | Progress and content breakdown of an earlier run |
| `--reset` | Clear partition progress. Does **not** delete tenders |
| `--dry-run` | Plan and measured volumes, nothing written |

**Resumable.** Work is tracked per month partition in `seed_partitions`. Ctrl-C is
safe: a partition stopped mid-window returns to `PENDING` rather than being marked
done, so the next run picks it up instead of silently skipping that month. A
partition abandoned by a killed process is reclaimed after its heartbeat goes stale.

**Idempotent.** Re-running seeds nothing twice — the second pass reports the same
notices as `unchanged`.

Partitions run newest-first, so an interrupted seed still leaves the most useful
months populated.

## Tender documents

Tenders carry `documents[].url` pointing at a buyer portal. `tender_documents` is the
work list, filled by the writer **inside the same transaction** that commits a tender,
so a committed tender always has its document work recorded. Fetching happens after —
a portal being down can never delay a tender.

```bash
npm run fetch:documents                 # seed path: drain the queue, no Redis needed
npm run worker:documents                # live path: long-running
npm run fetch:documents -- --status     # coverage per host
```

| Command | Purpose |
| --- | --- |
| `--limit N` / `--concurrency N` | Bound a run |
| `--host <host>` | One portal, which is how a new resolver is exercised |
| `--backfill-rows` | Rows for tenders committed before this feature existed |
| `--retry-failed` | Requeue permanent failures after a resolver fix |
| `npm run documents:inspect -- <url>` | Run a resolver against a live URL and print what it found |
| `npm run documents:inspect -- --sample 12` | Same, for the top hosts in the database |

### Why this needs per-platform resolvers

Measured over one German publication day: **86% of document URLs are landing pages,
not files**, across **68 distinct hosts**. But those hosts are ~10 software families —
seven of the busiest German portals run cosinex — so resolvers are registered per
family in `documents/registry.ts`, keyed on a URL signature rather than a host list.
That way an unseen state portal works without a code change.

**Six platform resolvers** are implemented (plus the generic `directFileResolver`
fallback), together claiming **~63% of the corpus** (was 39% with the first two). See
[`DOCUMENT_RESOLVERS.md`](DOCUMENT_RESOLVERS.md) for the full coverage table and the
per-portal "cannot resolve, and why" list.

| Resolver | Hosts | Mechanism |
| --- | --- | --- |
| `cosinex` | 22 | any `…Satellite/` path → public `Vergabeunterlagen_<id>.zip` |
| `netserver` | 37 | `/NetServer/` → `_DownloadTenderDocuments` bundle ZIP (public subset; gated portals recorded `LOGIN_REQUIRED`) |
| `evergabe-online` | 1 | e-Vergabe Bund; cookie handshake + Wicket `zipDownloadButton` |
| `rib-meinauftrag` | 1 | **headless render** → `remote/download.php?k=…` per-file links |
| `aumass` | 1 | public "ohne Registrierung" `GetDocument?doctype=allfiles` ZIP |
| `staatsanzeiger` | 2 | GET choice page → **POST** `DownlAsAnonym` → `.zip` link |

`documents:inspect` is the tool for adding the next family: point it at a real URL,
see which links are picked up, adjust, repeat. Coverage is measured any time with
`npm run fetch:documents -- --coverage`.

### Three portal behaviours worth knowing

These were each found by running the code, and are handled in `documents/http.ts`:

- **Cookie handshakes.** `evergabe-online.de` redirects to `?…&cookieCheck` and
  answers **HTTP 400** unless the session cookie it just issued comes back. Node's
  `fetch` has no cookie jar and its automatic redirects run before anything can read
  `Set-Cookie`, so redirects are followed manually with a per-host cookie jar.
  Without this the whole family is unreachable.
- **Referer-bound download links.** The same portal's Wicket callbacks 403 without a
  `Referer`, so a resolver may attach one per file.
- **Pages that look like files.** A link matching the download heuristics can still
  serve HTML — an `?detail=` listing did, and 339 KB of navigation markup was archived
  as a tender document. The runner now rejects HTML responses that lack a document
  extension.
- **Two-step form downloads.** Staatsanzeiger offers the pack only after a POST
  ("Anonym als Zip"), so `DocumentFetcher.post()` submits the form over the same
  per-host cookie jar the preceding GET opened.
- **Single-page-app portals.** RIB `meinauftrag` (and others) build the document list
  in the browser, so `documents/browser.ts` provides an optional headless-Chromium
  `render()` / `capture()` (gated by `DOCUMENTS_BROWSER_ENABLED`; needs
  `npx playwright install chromium`). Resolvers call `http.render?.(…)` and degrade to
  a skip when the browser is unavailable.

### Auditing failures

Every outcome is persisted; nothing important lives only in the process log.

| Where | What |
| --- | --- |
| `tender_documents.status` + `skipReason` | Row outcome: `FETCHED`, `SKIPPED` (with reason), `FAILED` |
| `tender_documents.error` + `attempts` | Full error text for a failed row |
| `tender_documents.failedFiles[]` | **Per-file** failures: url, errorClass, message, retryable, timestamp |
| `tender_documents.files[].textStatus` / `textError` | Text extraction outcome per file |
| `dead_letter_events` | Permanently failed rows, same surface as notice failures |

`failedFiles` exists because a row with one good file and four failures is still
`FETCHED` — without it a partial success is indistinguishable from a complete one.
Every resolved file lands in exactly one of `files` or `failedFiles`.

```bash
npm run fetch:documents -- --status
```

reports file-level failures grouped by error class (with how many are retryable) and
text-extraction gaps, separately from row status.

### Scope

Documents are fetched only for tenders still worth bidding on
(`OPEN`/`CLOSING_SOON`/`UPCOMING`), since fetching every historical award's
attachments across the seeded corpus would cost terabytes for no product value. Set
`DOCUMENTS_BIDDABLE_ONLY=false` to widen. A tender moving `UPCOMING` → `OPEN` has its
documents promoted automatically. Documents the source flags `restricted-document` are
never fetched.

**robots.txt is not consulted**, by explicit decision for internal use. Several
portals (the cosinex family, subreport) send `Disallow: /`. Note that this contradicts
§4.2 and §16 of `MONGODB_TENDER_SEEDING_AND_INGESTION_ARCHITECTURE.md`, which should be
amended so the spec and the code agree. Per-host rate limits, backoff and circuit
breakers are in place regardless — avoiding an IP ban is the practical goal — and the
User-Agent is honest. UA rotation and proxy pools are deliberately not implemented.

Login-gated portals are skipped and no credentials are handled anywhere.

## Operating

```bash
npm run ingestion:bootstrap                  # collections, indexes, configs, access checks
npm run ingestion:bootstrap -- --check-storage   # also round-trips one probe object through S3
npm run ingestion:verify                     # section 17.3 persistence suite
npm run ingestion:smoke -- --source DE_BUND --adapter-only
npm run ingestion:smoke -- --source TED --limit 25
npm run ingestion:backfill -- --source DE_BUND --dry-run
npm run ingestion:backfill -- --source TED --months 6
npm run ingestion:replay -- --error-class MALFORMED_PAYLOAD --limit 100
npm run ingestion:parse -- ./fixtures/de --summary
```

`--adapter-only` exercises access, discovery, and parsing against the live source
with no MongoDB, Redis, or S3, so a failure is unambiguously the adapter.

Enable live discovery **before** starting a backfill, so nothing published during
the seed is missed (section 9.2).

### Changing intervals without a deploy

`source_configs` is read on every scheduler tick.

```js
db.source_configs.updateOne({ _id: "TED" }, { $set: { liveIntervalSeconds: 60 } })
db.source_configs.updateOne({ _id: "DE_BUND" }, { $set: { enabled: false } })
```

### Shadow mode

`INGESTION_SHADOW_MODE=true` writes MongoDB and marks outbox events delivered
without publishing them — the section 18.3 cutover step.

## Observability

Every worker serves `/healthz` and `/metrics` (Prometheus text) on
`INGESTION_METRICS_PORT`, default 9464.

Alert-worthy series, per section 15.3:

| Metric | Alert |
| --- | --- |
| `ingestion_last_success_seconds{mode="live"}` | No success for 15 min on a required source |
| `ingestion_source_watermark_seconds` | Not advancing during a publication period |
| `ingestion_queue_oldest_age_ms{queue="live"}` | Over 5 minutes |
| `ingestion_dead_letter_depth` | Increasing |
| `ingestion_outbox_lag_ms` | Over 2 minutes |
| `ingestion_source_circuit_open` | Any source at 1 |
| `ingestion_notices_written_total{outcome=...}` | Unknown-type or rejection rate rising |

## Environment

See `.env.example`. Required: `MONGODB_URI` (replica set), `REDIS_URL`, and the
`S3_*` variables. Optional: `TED_API_KEY` to switch TED onto official per-notice XML
for richer structured fields — **not** required for document links, which the anonymous
Search API already provides.

MongoDB **must** be a replica set — transactions and change streams depend on it,
and every worker asserts this at startup rather than failing on first commit.

## Consuming changes in the app

`GET /api/tenders/events` is a Server-Sent Events feed backed by the outbox relay.

```
/api/tenders/events?cpv=45&country=DE&status=OPEN
```

CPV filters match by prefix, so `45` matches `45232421`. Events for historical
inserts and deadline sweeps carry `suppressNotifications: true` and are withheld
unless `includeSuppressed=true`.

Events are hints, not data: read the current document from `tenders`, which is
always the authority.

## Verification status

Run against live sources and a real replica set on 2026-08-05.

| Area | Status |
| --- | --- |
| eForms parser | 853/853 notices from a full German publication day, 0 failures, 9 notice types |
| Germany adapter | Live: access, ETag, ZIP streaming with checksum, 853 notices discovered |
| TED adapter | Live: access, ITERATION paging, 212-notice page, parse, canonical keys |
| Transactional writer | 36/36 persistence checks (`npm run ingestion:verify`) |
| Concurrency and idempotency | Verified: 4 parallel writes → 1 version, 1 `INSERTED` |
| Cross-source linking | Verified: DE + TED on one procedure id → 1 aggregate, both records kept |
| False-merge protection | Verified: identical titles, different procedure ids → 2 aggregates |
| Outbox | Verified: versioned, unique, correct event types, suppression on backfill |
| S3 raw store | Verified: upload, checksum, read-back, delete against the R2 bucket |
| MongoDB indexes | Verified created, including the split geo indexes |
| TypeScript | `npm run typecheck` clean |
| Seeder (`seed:tenders`) | Verified live: Germany 2,090 discovered → 22 written; TED 212 → exactly 10 written; 0 failed; re-run reported 10 unchanged; truncated partitions correctly returned to `PENDING` |
| Document retrieval | Verified live end to end (cumulative): **233 tenders `FETCHED` → 3,705 files, 2,115 MiB in R2, 3,209 with extracted text**, 0 file failures on the fetched rows. 6 platform resolvers claim ~63% of the 26,267-doc corpus (up from 39%). ~11,700 rows still `PENDING` (rate-limited drain) |
| cosinex resolver | Verified on 4 hosts in the family (`brandenburg`, `dtvp`, `niedersachsen`, `giz`), both URL shapes (`/notice/<id>` and `/notice/<id>/documents`) |
| evergabe-online resolver | Verified: cookie handshake + Referer + ZIP unpack → 28 files from one tender |
| netserver resolver | Verified 2026-08-07 across 37 hosts: `tender24` (14 MB ZIP → 4 files), `vmstart` (19 MB ZIP); gated portals (`sachsen-vergabe`, `landbw`, `hessen`, `fraunhofer`) correctly `LOGIN_REQUIRED` |
| aumass resolver | Verified 2026-08-07: public `doctype=allfiles` bundle → 16 files stored |
| staatsanzeiger resolver | Verified 2026-08-07: GET choice page → POST `DownlAsAnonym` → ZIP → 29 files stored |
| rib-meinauftrag resolver | Verified 2026-08-07 (headless): rendered SPA → 3 PDFs with extracted text |
| XML entity decoding | 853/853 notices parse; 0 of 559 document URLs still contain `&amp;` |
| TED document links | Verified live: `document-url-lot` returns URLs from the anonymous Search API — 30/60 notices (50%), no API key |
| **Redis queue paths** | **Not yet run.** No Redis was available on this machine |

The Redis-dependent code — `StreamQueue`, scheduler enqueue/dequeue, retry
promotion, stall reclaim, and the outbox pub/sub fan-out — is written and
typechecks, but has not executed against a live Redis. To verify:

```bash
docker compose -f docker/docker-compose.yml up -d redis mongo mongo-init
```

```bash
npm run ingestion:smoke -- --source DE_BUND --limit 10
```

That runs the full path — discover, enqueue, dequeue, fetch, parse, store, commit —
and prints the resulting collection counts and status distribution.

### Running the persistence suite without Docker

The suite needs only a replica set. With MongoDB installed locally:

```bash
mongod --replSet rs0 --port 27018 --dbpath /tmp/mongo-rs --bind_ip 127.0.0.1
```

```bash
mongosh --port 27018 --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27018"}]})'
```

```bash
MONGODB_URI="mongodb://127.0.0.1:27018/?replicaSet=rs0" npm run ingestion:verify
```

It uses a throwaway database (`bauai_ingestion_verify`) and drops it on exit.

`fixtures/de/` holds one real eForms notice for the suite and for
`npm run ingestion:parse`. Section 17.2 asks for a fixture per notice type; that
set still needs filling out.

## Not yet done

- Wave 1-3 adapters (TenderNed, BOAMP, PLACSP, BZP, and later). `sources/registry.ts`
  takes one at a time behind the section 19 gates.
- Enrichment workers. `tenders.enrichment` states are written as `PENDING` and
  nothing consumes them yet; by design, an enrichment failure cannot block a
  tender from appearing.
- Atlas Search indexes and the search API (section 12, phase 4).
- The section 17 automated test suite. Verification so far is the fixture parser
  over a full publication day plus live adapter smoke runs.
