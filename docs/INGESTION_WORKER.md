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
- `GET /v3/notices/{publicationNumber}` requires an API key, and the
  `ted.europa.eu/.../xml` web URLs sit behind a bot challenge. Without
  `TED_API_KEY`, the search response is the raw payload of record; parsed notices
  carry a `ted-search-projection` warning to make that visible
- Licence: EU reuse decision `2011/833/EU`

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
`S3_*` variables. Optional: `TED_API_KEY` to switch TED onto official per-notice
XML.

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
