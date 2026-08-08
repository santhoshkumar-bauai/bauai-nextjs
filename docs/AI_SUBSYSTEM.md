# AI Subsystem

Everything under `lib/ai/` plus the routes, workers, scripts and UI that make
tenders searchable, extractable and analyzable. Built as the deterministic
foundation the roadmap (`BAU_AI_AGENTIC_TENDER_ROADMAP.md`) requires before
the Clara/Dora/Nova agents. Companion docs: `docs/GLOSSARY.md` (German
procurement terms ↔ English identifiers), `docs/INGESTION_WORKER.md`,
`docs/DOCUMENT_RESOLVERS.md`.

## Architecture at a glance

```
tenders / tender_documents (ingestion, global)
        │
        ▼  ai-indexer worker (npm run worker:ai)
┌─ notice embedding sweep ─────► tender_search_documents (44k vectors)
├─ doc sweep: chunk → embed → classify ─► chunks (+docClass)
├─ BullMQ consumers: ai-embedding, ai-extraction queues
└─ company_doc_embed: company files → tenant-scoped chunks
        │
        ▼
hybrid retrieval ($search german + $vectorSearch + RRF + reranker slot)
        │
        ├─► extraction engine (7 schemas, citation-verified)  → extractions
        ├─► tender overview (bilingual, notice-only capable)  → tender_overviews
        └─► company-fit analysis (tenant-scoped, hash-cached) → tender_fit_recommendations
```

**Core rules** (roadmap §6): tender-derived data is global; company-derived
and AI-personalized data is tenant-scoped (`tenantId` = `Company._id`),
accessed via `TenantRepository` which injects the tenant server-side. An
uncited factual claim is a bug: extraction values carry verbatim quotes
mechanically verified against the source. Derived artifacts are reproducible
and replaced wholesale, never patched.

## Module map (`lib/ai/`)

| Module | Purpose |
|---|---|
| `config/env.ts` | Lazy zod-validated env (`aiEnv()`); role→model map; all knobs below |
| `gateway/` | Provider-agnostic model access. `getGateway().embed(...)` / `.generateStructured(...)`. Gemini adapter (raw fetch, retry, L2-normalized MRL vectors). New provider = one adapter + registry entry |
| `db/` | `getAiCollections()` (shared pooled client), plain indexes, Atlas search-index creation (`ensureAiSearchIndexes`, used by `npm run ai:bootstrap`) |
| `tenant/` | `TenantRepository` (server-injected tenantId, cross-tenant queries inexpressible), `forCompanyContext` / `forJobPayload` |
| `queue/` | BullMQ on prefix `{bauai:ai}` (ioredis conflict-free via plain options). Job payloads zod-validated; idempotency keys double as BullMQ jobIds |
| `worker/indexer.ts` | `AiIndexer`: registerProcessor/registerProducer harness on the ingestion `runWorker` runtime |
| `embedding/` | Notice sweep (batched `batchEmbedContents`, ledger = `tenders.enrichment.embedding`), chunk embedder, doc sweep (chunk+embed+classify newest-first), outbox pub/sub push |
| `chunking/` | Section-aware chunker (char-offset anchors, one-sentence overlap), German legal-ref extractor (`§ 13 VOB/B`) |
| `classification/` | docClass: heuristics-first (German filename/heading rules), Gemini fallback, `document_classifications` + stamps `chunks.docClass` |
| `retrieval/` | Keyword arm (`$search`, `lucene.german`, exact legalRefs boost), vector arm (`$vectorSearch`), app-side RRF (k=60), reranker slot (noop/llm). **Company corpus uses separate `CompanyCorpusFilters` — tenantId required non-null, no shared-null branch. Never merge with tender filters** |
| `extraction/` | 7 English-named schemas (`deadlines`, `suitability_criteria`, `award_criteria`, `required_proofs`, `contractual_penalties`, `payment_terms`, `alternative_bids`), citedValue contract, hybrid engine (retrieval-targeted + top-3 full docs), quote verification with ≤2 retries, per-(tender, schema) records keyed by `corpusHash` |
| `overview/` | Tender-centric dossier (about/scope/buyer/timeline/requirements/risks/highlights), **bilingual in one call** (`{en, de}` stored, UI picks by locale), works notice-only, runs inline (no worker needed) |
| `fit/` | Company-fit: full company context builder, `companyDataHash` (profile + embedded docs → staleness), prompt with company evidence + verified tender facts |
| `company/` | `company_doc_embed` processor: S3 → text-extract → chunk → embed as tenant chunks (`tenderId: null`, `documentRecordId: company:{fileId}`) |
| `eval/` | Retrieval eval (canonical §17.5 questions, hit@k/MRR). Baseline: `evals/retrieval-baseline-2026-08-08.json` (hybrid hit@5 = 1.00 DE / 0.92 EN) |

## Collections

| Collection | Scope | Key facts |
|---|---|---|
| `tender_search_documents` | global | 1 per tender; curated text + 1536-dim vector + filters; unique `tenderId` |
| `chunks` | global OR tenant | tender chunks (`tenantId: null`) and company chunks (`tenderId: null`); char-offset anchors; `docClass`; `legalRefs`; embedding identity fields |
| `document_classifications` | global | per file: docClass, confidence, method (heuristic/llm), rule |
| `extractions` | global | 1 per (tenderId, schemaName); `fields` of StoredCitedValue (value, confidence, citations with quoteHash, citationState VERIFIED/UNVERIFIED/MISSING); `corpusHash` re-extraction trigger; status VERIFIED/PARTIAL/EMPTY/FAILED |
| `tender_overviews` | global | 1 per tender; `overview.{en,de}`; `sourceChunkCount` (0 = notice-only); prompt version `ov-p2` |
| `tender_fit_recommendations` | **tenant** | 1 per (tenantId, tenderId); `companyDataHash` → staleness; TenantRepository-only access |
| `ai_index_state` | global | work ledger; `_id` = idempotency key (`chunk:doc:…`, `class:doc:…`, `extract:…`, `company:…`); PENDING/RUNNING/DONE/FAILED |
| `geo_cache` | global | postal-centroid geocoding cache shared by map + backfill |

Embedding identity on every vector: `embeddingModel` (gemini-embedding-001),
`embeddingVersion` (env, bump to re-embed via sweep), `embeddingDimensions`
(1536), `sourceHash` (sha256 of embedded text → no-op replays).

## API surface

| Route | What |
|---|---|
| `POST /api/ai/retrieve` | Tender-scoped hybrid chunk search (auth-gated, tenant filter injected) |
| `POST /api/tenders/[id]/extract` | Enqueue extraction (all or selected schemas); idempotent per (schemaVersion, promptVersion, corpusHash); 409 when tender has no chunks |
| `GET /api/tenders/[id]/extractions` | Stored extraction records |
| `GET /api/tenders/[id]/extract/status` | Live per-schema RUNNING/FAILED from the ledger (poll target) |
| `GET/POST /api/tenders/[id]/overview` | Bilingual tender overview; POST regenerates **inline** (no worker needed) |
| `GET/POST /api/tenders/[id]/recommendation` | Company fit; GET returns cache + `stale` flag; POST regenerates with full company context |
| `POST /api/company/documents` (side effect) | Upload confirm enqueues `company_doc_embed` |
| `DELETE /api/company/documents/[id]` (side effect) | Removes the file's tenant chunks + ledger rows |

## Tender popup (`components/tenders/detail/`)

Decomposed dialog: header `DeadlineChip` (days-left countdown; urgency bands
from `lib/tenders/deadline.ts`: <7d red, 7–14 amber, closed gray), enriched
About (CPV sector labels, regions, client card), Schedule (expandable lots),
Documents, AI tab. UI primitives added: `components/ui/{badge,progress,skeleton}.tsx`.

AI tab behavior: **auto-fires on first open** (if no stored overview →
generates overview inline + enqueues extraction; at most once per tender).
Overview card renders the active locale's language from the stored bilingual
record. Extraction schema cards fill via 3.5s polling while `worker:ai`
processes; each field shows value, confidence, citationState badge and
expandable verbatim German quotes. The **company fit lives in the floating
chat-style bubble** bottom-right (`fit-assistant.tsx`) — deliberately shaped
as the future Dora chat seat.

All strings exist in `messages/en.json` + `de.json`; parity enforced by
`messages/parity.test.ts`.

## Dev environment

- **MongoDB**: `mongodb/mongodb-atlas-local:8.2` container ("bauai-mongo"
  hostname pinned — the replica set is named after it; recreating without the
  pin bricks the node as RSGhost). Host port **27018**
  (`mongodb://127.0.0.1:27018/bauai?directConnection=true`); 27017 is the
  personal Windows mongod, not used by this project. `mem_limit: 4g` guards
  against mongot memory starvation. Search indexes are real Atlas Search —
  same query code as production Atlas.
- **Redis**: docker `redis:7` on host port **6380** (6379 is a Windows Redis 5
  service; BullMQ needs ≥6.2). Ingestion StreamQueue and BullMQ share it under
  different prefixes.
- Both containers `restart: unless-stopped`.
- **Worker**: `npm run worker:ai` — required for extraction jobs and
  company-doc embedding; overview + fit run inline without it.

## Runbook

```bash
npm run ai:bootstrap            # collections + plain & search indexes (idempotent)
npm run worker:ai               # BullMQ consumers + sweeps (newest-first everywhere)
npm run ai:backfill:notices     # monitor notice-embedding convergence (--watch)
npm run ai:backfill:chunks      # chunk+embed all fetched docs inline
npm run ai:classify:backfill    # docClass backfill (--llm=false = free dry pass)
npm run ai:extract -- --tenders 3        # batch extraction (--force ignores ledger)
npm run ai:embed:company        # embed existing company files (--company <id>)
npm run ai:eval                 # retrieval eval vs canonical questions (--json out)
npm run geocode:backfill        # buyer.location backfill (--dry / --all / --limit N)
npm run test                    # 149 unit tests; AI_INTEGRATION=1 adds e2e suites
```

All pipelines are **ledger-resumable**: kill anything anytime; re-runs skip
DONE work. Every processing loop claims **newest-first**.

## Env vars (all defaulted; see `.env.example`)

`GEMINI_API_KEY` (required for AI) · `EMBEDDING_MODEL/VERSION/DIMENSIONS/BATCH_SIZE/RPM`
· `AI_MODEL_ROLES` (role→`provider:model` JSON) · `AI_REDIS_PREFIX` ·
`AI_WORKER_CONCURRENCY` · `AI_USE_RANK_FUSION` · `AI_RERANKER` ·
`CHUNKER_VERSION` + `CHUNK_TARGET_TOKENS/MAX_TOKENS` · `CLASSIFIER_VERSION` ·
`AI_EXTRACTION_MAX_CHUNKS/MAX_DOC_CHARS/RPM/CONCURRENCY`

Version bumps re-process via the sweeps: `EMBEDDING_VERSION` → re-embed,
`CHUNKER_VERSION` → re-chunk, `CLASSIFIER_VERSION` → re-classify; extraction
schema/prompt versions live in code and are part of the idempotency keys.

## Hard-won gotchas

1. **Worker code must not import Mongoose models** — CJS named exports break
   under the `--experimental-strip-types` ESM loader. Use the native driver
   (e.g. `companyfiles` collection).
2. **Client components must not import modules that pull `node:crypto`** —
   e.g. use `lib/ai/extraction/schema-names.ts`, not the schema registry.
3. **`$search`/`$vectorSearch` require `readConcern: local`** — the shared
   client defaults to majority; every search aggregation passes it explicitly.
4. **tailwind-merge treats position utilities as one group** — adding
   `relative` to `DialogContent` replaces its `fixed` and breaks centering.
5. **Vitest + `.env.local`**: `@next/env` skips `.env.local` when
   `NODE_ENV=test`; `vitest.setup.mts` masks NODE_ENV during load.
6. **atlas-local recovery**: if the runner panic-loops after a hard stop, run
   `mongod` standalone on the volume until "Waiting for connections", clean
   shutdown, restart the service.
7. **Chunk `text` includes a prepended overlap sentence** not covered by its
   `charStart/charEnd` — citation anchors are chunk-granular by design until
   the Python parser brings page/bbox.

## Current state & what's next

Data (local dev): 44,865 embedded notices · ~26k+ chunks (growing with the
documents fetcher) · ~2.7k classified files · extraction/overview/fit proven
end-to-end on real tenders.

Deliberately not built yet: extraction golden labels + accuracy eval (roadmap
§31), page/bbox citations (Python document worker), OCR, real cross-encoder
reranker, `$rankFusion`.

**Next: the agents.** The chat bubble in the tender popup is Dora's seat. The
roadmap's design (§19–22) maps directly onto what exists: agent tools are
thin wrappers over `getExtractions`, `getTenderOverview`, `hybridRetrieveChunks`,
`searchNotices` and the fit service; LangGraph.js checkpointing gets an
`agent_runs` collection following the ledger pattern; chat answers
structured-artifacts-first (extractions/overview) with retrieval fallback and
citation chips — all of which this layer already produces.
