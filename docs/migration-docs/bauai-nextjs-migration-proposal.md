# BauAI Platform Migration Proposal

## `mvp1-bauai` + `bauai-go` → `bauai-nextjs`

| | |
|---|---|
| **Document type** | Engineering proposal & migration plan |
| **Authors** | Santhosh & Rishi |
| **Status** | Proposed — v2, **evidence-audited against all three codebases on 2026-08-11** |
| **Date** | August 2026 |
| **Audience** | Engineering, Product, Leadership |
| **Repos audited** | `Bau-AI/mvp1-bauai` (branch `development`, HEAD `31c6746`, 3,701 commits since 2025-02-25) · `Bau-AI/bauai-go` (34 commits since 2026-02-25) · `Bau-AI/bauai-nextjs` (branch `master`, HEAD `56a08b2`, 68 commits, 2026-08-04 → 2026-08-11) |

> **How to read this document.** Every claim about the codebases below carries a file path or a number measured directly from the repos on 2026-08-11. Anything about the future is explicitly a proposal. Where v1 of this document was wrong about what exists, v2 says so.

### Changelog — v2 corrections after the code audit

v1 of this proposal was written without full codebase context. The audit corrected these claims:

1. **The new platform runs on MongoDB, not Postgres.** There is no Postgres, Prisma, or Drizzle anywhere in `bauai-nextjs`; `MONGODB_TENDER_SEEDING_AND_INGESTION_ARCHITECTURE.md:7` states MongoDB replaces the Supabase/PostgreSQL design. Consequently, **"RLS-by-default" is replaced by "tenant-isolation-by-default"** with MongoDB-appropriate enforcement (Section 4.11) — the machinery for it already exists in code.
2. **Better Auth is live, but its organizations plugin is not used.** `lib/auth.ts` has no `plugins:` key. Tenancy is a hand-rolled `Company` model with embedded members, roles, and membership requests (Section 3.2.1). The code convention is `tenantId`/`companyId`, not `organizationId`.
3. **Onboarding already exists in `bauai-nextjs`** (dedicated route + 1,099-line catalog + seed scripts) — v1 listed it as "to rebuild".
4. **The ingestion work queue is Redis Streams, not BullMQ** — a deliberate, documented deviation (`docs/INGESTION_WORKER.md`). BullMQ is used for the AI job queues.
5. **A third repo exists and v1 ignored it:** `bauai-go`, a live Go/Fiber AI backend (~10.7k LOC) serving the MVP1 frontend. Its features are now in the parity matrix (Section 5.2).
6. **The Feature Parity Matrix is now filled in** from the actual MVP1 + Go feature inventory (36 rows), instead of "team to enumerate".
7. **Security incidents found during the audit** (committed service-role key, key logged in production, unauthenticated Go endpoints) are listed in Section 2.3 with an "act immediately" box.
8. LangChain + LangGraph integration is confirmed and far deeper than v1 claimed: a production LangGraph agent ("Clara") with 20 tools, Mongo checkpointing, and SSE streaming (Section 3.2.5).

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Where we are today — the evidence](#2-where-we-are-today--the-evidence)
3. [Target state: the `bauai-nextjs` monolith](#3-target-state-the-bauai-nextjs-monolith)
4. [What we are proposing](#4-what-we-are-proposing)
5. [Migration plan](#5-migration-plan)
6. [Engineering rules going forward](#6-engineering-rules-going-forward-the-contract)
7. [Risks and mitigations](#7-risks-and-mitigations)
8. [Success metrics](#8-success-metrics)
9. [FAQ / anticipated objections](#9-faq--anticipated-objections)
10. [Decision and next steps](#10-decision-and-next-steps)
- [Appendices: ADR template, PR checklist, Definition of Done, Verification guide](#appendix-a--adr-architecture-decision-record-template)

---

## 1. Executive summary

We propose **fully migrating BauAI from the current `mvp1-bauai` + `bauai-go` codebases to the new `bauai-nextjs` monolith**, and adopting a defined engineering process around it (environments, PR reviews, sprints, documentation-first).

The current MVP did its job: it proved the product, and it encodes real domain knowledge (CPV/NUTS taxonomies, eForms/TED parsing, German-market i18n, a working Stripe billing surface). But it was built for speed, and the audit puts numbers on the price we pay daily:

- **~307,000 lines of code across 1,763 files**, deployed as a Vite SPA plus **12 separately-deployed backend pieces** (11 Node services/directories + 1 Go service) with no shared code, no shared build, and no shared data-access layer.
- **The browser queries the database directly** — 283 raw table queries across 91 frontend files against 32 tables — while **29 of 122 tables have no Row-Level Security at all, including `companies` and `memberships`**, the two tables that define tenancy. 35 of the policies that do exist are `USING (true)`.
- **The RLS-bypassing service-role key is used in 673 places across 213 files**, is **committed to git in `.env`**, and is **printed to production logs** by an ingestion function.
- **Ingestion has no queue, no retries, no dead-letter handling** — failures are counted, dropped, and re-driven by hand (41 ad-hoc backfill scripts; committed `backfill-failed.txt` files as evidence of manual recovery).
- **Zero observability**: no error tracking, no tracing, no LLM observability. The repo itself documents a **€12k API-cost incident (April 2026)** whose only guardrail today is a comment in a deploy note.
- **CI never runs on the active branch** (it targets `main`/`dev`; work happens on `development`), runs no lint or typecheck, and there are 7 test files for 137k LOC of frontend and 0 for any backend.

Critically, **this is not a rewrite from zero.** In one intensive week (68 commits, Aug 4–11), the riskiest parts of the platform have been rebuilt properly in `bauai-nextjs` and are working — with ~60k lines of TypeScript, 50 test files (385 tests), and 5 architecture documents:

- **Authentication** — Better Auth on MongoDB: email+password with mandatory verification, Google/Microsoft SSO, and a Company (tenant) membership model with roles and join-request approval
- **Ingestion pipeline** — two live sources (German national data service + EU TED), Redis-Streams work queue with retries and a replayable dead-letter queue, transactional outbox, six dedicated workers, Prometheus metrics
- **Document pipeline** — 8 portal resolvers covering **63.2% of the 26,267-document corpus**, S3 storage, PDF/DOCX text extraction
- **AI foundation** — LangChain + LangGraph: the Clara agent (20 tools, Mongo-checkpointed, SSE-streamed), hybrid Atlas Search + Vector Search retrieval with a committed eval baseline, an AI matching pipeline, cited-and-verified structured extraction, and report generation (HTML/DOCX/PDF)
- **Tender UI** — search, filters, map, detail view with AI tabs, onboarding, 13 settings pages, full DE/EN i18n with machine-enforced parity

What remains is to finish porting the rest (the parity matrix in 5.2 now enumerates all 36 features), migrate tenant data, cut over customers, freeze the old repos — and put process guardrails in place so we **never end up in this situation again**.

**The core message:** the daily bugs are not bad luck and not a people problem. They are the measurable output of structural problems in the old codebases and the absence of an engineering process. Both are fixed by this migration.

---

## 2. Where we are today — the evidence

### 2.1 The current landscape is three codebases, not one

| Repo | What it is | Size | Commits | Runtimes |
|---|---|---|---|---|
| `mvp1-bauai` | Vite + React 18 SPA (Lovable-generated scaffold — `package.json` name is still `vite_react_shadcn_ts`) + 131 Supabase edge functions + 11 side services | ~307k LOC, 1,763 tracked files | 3,701 (Feb 2025 → Aug 2026, still active) | Node (npm+pnpm+bun), Deno |
| `bauai-go` | Go/Fiber AI backend on Cloud Run (port 3001): tender list ranking, fit scoring, Tika document extraction, form-filling, "Dora" chat endpoints | ~10.7k LOC | 34 (Feb → Aug 2026, still active) | Go 1.25 |
| `bauai-nextjs` | The new monolith: Next.js 16 + MongoDB | ~60k LOC (lib/ai 21.8k, ingestion 11.7k, components 13.5k) | 68 (Aug 4–11, 2026) | Node 24 |

The MVP1 backend alone is **12 separately-deployed pieces**: `nova-server`, `playwright-server`, `tender-processor-server`, `company-tender-processor`, `gcp-document-processor`, `doc-generator`, `can-company-emails`, `can-winner-profiles`, `services/db-worker`, `services/tender-document-downloader`, `services/tender-document-extractor`, plus `bauai-go`. **8 of the 11 Node pieces talk to Postgres directly with the service-role key**; so does the Go service. Three have no Dockerfile and no deploy script at all; two are deployed by copy-pasting `gcloud` commands out of `deploy.txt` files.

### 2.2 Fragmentation evidence

- **Three competing lockfiles for the same root `package.json`**, all git-tracked, last updated by three different tools on three different dates: `bun.lockb` (2026-06-29), `package-lock.json` (2026-07-13), `pnpm-lock.yaml` (2026-08-01). Plus 9 more nested lockfiles in sub-services. `pnpm-workspace.yaml` defines no workspace packages — every service is an island.
- **`deno.json` points at `./import_map.json`, which does not exist in the repo.** Inside `supabase/functions` there are 6 different `deno.land/std` versions and 7 different `@supabase/supabase-js` pins.
- **Copy-paste versioning instead of git**: `fetch-tenders` / `fetch-tenders-2` / `fetch-tenders-v3` / `cron-fetch-tenders` / `cron-refresh-tenders` (5 overlapping ingestion implementations); `register` / `register-v5`; `chat` / `chat-gpt`; `document-processor` / `document-processor-fast`.
- **~3,500 lines of agent logic maintained in two places**: `supabase/functions/nova-agent/index.ts` (3,498 LOC) vs `nova-server/src/nova-agent.ts` (3,575 LOC).
- **The database type definitions exist in triplicate**: `src/types/supabase.ts` (4,494 LOC), `src/types/database.types.ts` (4,120), `src/access-client/types.ts` (4,051) — 12,665 lines that must be regenerated in lockstep.
- **TypeScript strict mode is off everywhere** (`tsconfig.app.json`: `"strict": false`, `noImplicitAny: false`; 276 explicit `: any` in `src/`), and ESLint disables `no-unused-vars`.

### 2.3 Security & tenant isolation evidence

Measured in `supabase/migrations/` (124 files, 33,860 LOC):

| Metric | Count |
|---|---|
| Tables created | **122** |
| Tables with `ENABLE ROW LEVEL SECURITY` | **93** |
| **Tables with RLS never enabled** | **29** — including `companies` (its 2 policies are inert), `memberships` (0 policies), `user_saved_tenders`, `user_disliked_tenders`, `tender_analyses`, `eforms_tenders_simplified_duplicate` |
| `CREATE POLICY` statements | 357 |
| Policies whose predicate is `USING (true)` (allow-everyone) | **35** |
| Policies granted `TO "anon"` | 254 |
| References to `auth.uid()` in the 328-policy baseline | 29 |

Meanwhile the **frontend queries the DB directly from the browser**: 283 `.from('table')` call-sites across 91 files — including inside UI components (`TenderListPage.tsx` 7, `OnboardingModal.tsx` 6, `CommentInput.tsx` 6). The browser hits `companies` 36 times — a table with RLS off. **Tenant scoping is whatever `.eq('company_id', …)` each of those 283 call-sites remembered to add.** One omission anywhere = cross-tenant leak with no database backstop.

On the server side, **`service_role` (RLS-bypassing) is used 673 times across 213 files**. Of 131 edge functions, only 11 are configured in `config.toml` — and 10 of those set `verify_jwt = false`. Only 49 of 125 function entrypoints call `auth.getUser()`. 54 functions hardcode `Access-Control-Allow-Origin: *`.

`bauai-go` adds its own hole: **its auth middleware does not verify JWTs at all** — it reads a `userId` from the query string or request body and trusts it (`internal/middleware/auth.go`; the `jwt/v5` import is commented out, and the fix lives on an unmerged branch `fix/verify-supabase-jwt-auth`). Anyone who knows a user's UUID is that user. Batch endpoints (`/insert-text-to-db`, `/jobs/geocode-tenders`) are mounted with no auth whatsoever.

> **🔴 Act immediately, regardless of the migration decision:**
> 1. **A live Supabase service-role key is committed to git** — `.env` is tracked at `mvp1-bauai` HEAD (the `.gitignore` entry was added after the file was tracked, so it has no effect). Rotate the key, purge the file from history.
> 2. **The service-role key is printed to production logs**: `supabase/functions/cron-fetch-tenders/index.ts:32` does `console.log("Supabase Service role key is :", …)`. Delete the line, rotate the key.
> 3. **`bauai-go` trusts client-supplied `userId`** (above). Merge/finish `fix/verify-supabase-jwt-auth` or gate the service.
> 4. **`bauai-go`'s Docker image bakes in `.env`** (Supabase service-role + Gemini keys end up in image layers — `dockerfile:33 COPY .env .env`). Move secrets to Cloud Run env/secret config.
> 5. **A GitHub personal-access token with push rights is embedded in a local git remote URL** (`bauai-go` checkout, `.git/config`). Rotate it; switch the remote to SSH or a credential helper.

### 2.4 Ingestion fragility evidence

- **No queue.** The "pipeline" is an HTTP POST (`tender-processor-server/src/handlers/pipeline.ts`, 82 lines) that runs a whole day's ingestion synchronously inside one Cloud Run request. No SQS/PubSub/pgmq/Redis anywhere in MVP1.
- **No dead-letter handling, no re-drive.** Zero matches for "dead letter"/"dlq" in the repo. The `tender_pipeline_runs.failed_notice_ids` column is **written but never read** (its only repo-wide occurrence is the `ADD COLUMN` migration). A notice that fails parsing is counted and dropped.
- **Retries exist only as three narrow patches** (one HTTP-429 retry in `tedIngestService.ts`, insert backoff in `processTarGzFile.ts`, geocoding retries). Nothing at the pipeline level.
- **The daily-ingest schedule is not codified.** The only Cloud Scheduler definition for it is `echo`-ed paste-me-manually instructions in `tender-processor-server/deploy-new-service.sh:202-209`. `pg_cron` schedules only trial emails and a competitor digest — not ingestion.
- **Manual recovery is the process**: 41 root-level `backfill-*/re-transform-*/clean-*` scripts in `tender-processor-server`, and committed run-artifacts (`backfill-failed.txt`, `backfill-deferred.txt`, `migration-failed.txt`, seven `backfill-report-*.json` files) in `scripts/`.
- One production ingestion function contains a **mock-data fallback** path (`cron-fetch-tenders`: "fallback to mock data if API is not available").

### 2.5 Observability & AI-cost evidence

- **Zero observability tooling.** A repo-wide search for langfuse, langsmith, sentry, opentelemetry, datadog, posthog, helicone, braintrust, newrelic, winston, pino returns **nothing** in MVP1. Telemetry is 1,293 `console.log` calls in edge functions — and the Vite production build **drops frontend console output entirely** (`esbuild.drop: ['console']`).
- **LLM calls are made from at least 8 separately-deployed runtimes**, each with its own Gemini client copy (4 separate `gemini.ts` helpers), its own key env-var, its own error handling. No prompt versioning, no evals, no cost attribution.
- **The €12k incident is documented in the repo itself**: `services/tender-document-extractor/deploy.txt` explains this service must never call `generate-summary` — "the €12k Apr 2026 incident" — and `tender-document-downloader/deploy.txt` describes a "permanent cost fence" implemented as… a placeholder API key and a commented-out import. Our cost controls are comments in text files.

### 2.6 Process evidence

- **CI cannot catch anything.** `.github/workflows/node.js.yml` triggers on `main`/`dev` — but **there is no `dev` branch**; active work merges into `development`, where CI never fires. It runs no lint and no typecheck. Its own comment admits tests "could not actually block a merge" historically.
- **7 test files** for 623 files / 137k LOC of `src/`; **zero tests** in 70k LOC of edge functions, 19.6k LOC of `tender-processor-server`, and every other service. `bauai-go` has exactly 1 test file, and `go build ./...` fails on a dead legacy package (`internal/Manager/`).
- **Documentation is gitignored by policy**: `.gitignore` line 42 is `*.md`. Four markdown files survive in the entire repo. The README **contains a committed merge conflict** (`<<<<<<< HEAD`) and still describes the product as a construction ERP (Gantt, warehouses, inventory) — a scope that no longer exists.
- **Deploys are tribal knowledge**: 3 shell scripts (one with an interactive prompt), 2 `deploy.txt` copy-paste files, no IaC.

### 2.7 Incremental refactoring was already tried — it did not converge

`.agents/anirban's-notion-doc.txt` is an internal **"BauAI Codebase Refactoring Plan" dated 2026-02-09**: full migration to feature-based architecture, a typed access-client, a query layer, file-based routing. Six months later: `src/access-client/` exists but contains only a client singleton and generated types — **no query layer, no repositories**; the plan's `core/`, `queries/`, `routes/` folders were never created; the codebase still has 283 ad-hoc queries in 91 files. This is direct evidence that patching MVP1 in place does not work against daily feature pressure — which is exactly the objection Section 9 answers.

### 2.8 Root-cause analysis — why the bugs keep happening

| Symptom we see daily | Root cause (measured above) | How the target state fixes it |
|---|---|---|
| "Fixed one thing, broke another" | 12 deployed pieces + 131 functions with no shared code; 5 copies of ingestion; 2 copies of Nova; 3 lockfiles | One monolith, one build, one typed data layer (Section 3) |
| Cross-tenant anxiety / access bugs | 29 tables without RLS incl. `companies`+`memberships`; 283 browser-side queries; 673 service-role usages; Go API trusts client `userId` | DB is **never** exposed to the client; all access server-side through session-derived tenant scope + `TenantRepository` + isolation tests (4.11) |
| Ingestion silently fails or corrupts data | No queue, no DLQ, `failed_notice_ids` never read, manual backfill scripts | Redis-Streams queue with retry classes, circuit breaker, replayable DLQ, transactional outbox, per-worker metrics — already built (3.2.3) |
| Onboarding breaks for new customers | 1,589-line modal calling 3 different backends; 3 parallel guidance systems shipped at once | Single onboarding route + catalog + seeds — already built (3.2.6) |
| Bugs reach customers directly | CI on the wrong branch, no lint/typecheck, no staging | Preview → staging → production pipeline; protected `master`; CI gates (4.6–4.8) |
| "How does X even work?" takes a day | `*.md` gitignored; knowledge in deploy.txt files | Docs-first — already practiced in the new repo: 5 docs + 2 architecture plans (4.9) |
| AI behaves wrong and we can't say why; surprise bills | No tracing; 8 runtimes each calling Gemini their own way; cost fences as comments | Every agent a LangGraph graph (done) traced in Langfuse (to deploy); one model-role gateway with env-switchable providers (4.1) |
| Auth edge cases and session weirdness | Supabase Auth wrapped in a 225-line provider with a 5-second "safety timeout"; Go API has no real auth | Better Auth everywhere, one session model, one company-context gate — already built (3.2.1) |

### 2.9 What MVP1 got right — and must be preserved

The migration case is stronger for being honest. These assets are real and the migration must carry them forward, not discard them:

1. **The domain model** — 122 tables encoding German/EU procurement: CPV taxonomy + embeddings, NUTS regions, eForms/TED parsing, CAN winner/competitor intelligence, GAEB support. Years of domain knowledge.
2. **Bilingual i18n** — 11,260 LOC of DE/EN translations across 22 domain files. (Already re-established in the new repo with enforced parity — 3.2.7.)
3. **A complete Stripe billing surface** — checkout, portal, webhook (892 LOC), plan changes, addons, trial reconciliation, usage gates. **Not yet ported** — one of the largest remaining items (5.2).
4. **`src/features/doc-filler`** — a properly structured 63-file feature module (GAEB tender-document editor), the template the rest should have followed. Not yet ported; target for the ONLYOFFICE track (4.3).
5. **Deliberate cost/ops reasoning** — the `deploy.txt` notes contain real sizing and cost math. The new platform gives that thinking a structural home (docs/, ADRs, Langfuse budgets).
6. **Low comment-rot discipline** — only 6 TODO/FIXME markers in 137k LOC. The team keeps code clean at the line level; the problems are architectural, not sloppiness.

### 2.10 Known bug & incident inventory (living list — team to extend)

Seeded from the audit; **everyone should add the incidents they've hit**, with dates and links:

| # | Bug / incident | Area | Evidence | Fixed by migration? |
|---|---|---|---|---|
| 1 | €12k API-cost incident, April 2026 | AI / cost | `services/tender-document-extractor/deploy.txt` | ✅ One gateway + Langfuse budgets/alerts (4.1) |
| 2 | Service-role key committed to git; also logged in prod | Security | `.env` tracked at HEAD; `cron-fetch-tenders/index.ts:32` | ⚠️ Rotate **now** (2.3); new repo keeps secrets in env config with validated loading (3.2.8) |
| 3 | Go API authenticates by trusting client-supplied `userId` | Security | `bauai-go/internal/middleware/auth.go` | ✅ Better Auth sessions everywhere; also patch old system now |
| 4 | Tenancy backbone tables have no RLS | Security | `companies`, `memberships` et al. — 2.3 | ✅ Server-only DB access + enforced tenant scope (4.11) |
| 5 | CI never runs on the active branch; regressions land silently | Process | `node.js.yml` targets `main`/`dev`; work is on `development` | ✅ Protected `master` + CI gates (4.7, 4.10) |
| 6 | Ingestion failures dropped; manual backfills | Ingestion | `failed_notice_ids` written-never-read; `backfill-failed.txt` | ✅ Rebuilt pipeline with DLQ + replay (3.2.3) |
| 7 | Committed merge conflict in README | Process | `mvp1-bauai/README.md` lines 3–7 | ✅ Docs-first + PR review |
| 8 | Mock-data fallback in a production ingestion path | Ingestion | `cron-fetch-tenders/index.ts` | ✅ Typed adapters, fixtures live in `fixtures/`, not prod code |
| 9 | *[Team: add real examples with dates/links]* | | | |

> **Action:** keep this table updated until cutover. It doubles as our regression checklist — every row must be verified fixed in staging before we call the migration done.

---

## 3. Target state: the `bauai-nextjs` monolith

### 3.1 Why a monolith — and why that is not a step backwards

For a team of our size, a **modular monolith** is the correct architecture:

- **One repo, one deployment, one type system end-to-end.** A data-model change is a compile-time error everywhere it matters — versus today, where the same schema is defined in triplicate in the frontend and re-imagined per service.
- **One auth and session context.** Every request knows the user and the company (tenant). No more 8 backends each doing (or skipping) auth their own way.
- **Transactions and change streams work.** Multi-step operations are atomic; the ingestion outbox (3.2.3) is built on exactly this.
- **Operational simplicity.** One app image + one worker fleet to deploy, monitor, back up, and roll back — which matters enormously when we run our own infrastructure (4.2).
- **Modularity by discipline, not by network boundaries.** `lib/ingestion`, `lib/ai`, `lib/tenders`, `lib/company` are clear module seams. If one ever genuinely needs independent scaling, we extract it *then*, from a clean boundary.

The failure of MVP1 was never "monolith vs. services" — it was **no boundaries at all**. The evidence: the fix the team designed in February 2026 (2.7) was module boundaries and a typed data layer. That is what `bauai-nextjs` is.

### 3.2 What is already built — the evidence inventory

Everything in this section exists on `master` at HEAD `56a08b2` and is verifiable with the commands in Appendix D. Scale, from `git ls-files`:

| Area | Files | Lines | Area | Files | Lines |
|---|---:|---:|---|---:|---:|
| `lib/ai` | 135 | 21,813 | `app` (routes) | 70 | 4,957 |
| `components` | 82 | 13,473 | `scripts` | 25 | 4,026 |
| `lib/ingestion` | 66 | 11,707 | `lib/tenders` | 24 | 3,990 |
| `messages` (i18n) | 3 | 2,602 | `models` + `workers` | 11 | 993 |

Totals: **24 pages, 38 API routes, 67 UI components, 6 workers, 50 test files (385 tests), 5 architecture docs.**

#### 3.2.1 Authentication & tenancy (Better Auth + Company model)

- **Better Auth 1.6.25 with the official Mongo adapter** — `lib/auth.ts`, served by `app/api/auth/[...all]/route.ts`. Email+password (min length 8) with **mandatory email verification** (send-on-signup and on-signin, auto-sign-in after verify, 1h expiry) via Resend (`lib/email/`); **Google and Microsoft SSO** auto-enabled when credentials are present; trusted origins from env.
- **Tenant = `Company`** (`models/company.ts`): embedded `members[]` with roles `admin | member`, plus an embedded `membershipRequests[]` join-approval flow surfaced at `app/api/company/membership-requests/route.ts` and `components/company/membership-requests.tsx`.
- **One shared server-side gate**: `lib/company/context.ts` → `getCompanyContext({ requireAdmin? })` — checks session + email verification + active membership + onboarding state and returns `{ userId, role, company }`. **30 of the 38 API routes go through it**; 6 more are session-only (global reference data like CPV lookups); the only unauthenticated data route is the public SSE tender feed (global data by design — to revisit).
- Auth UI: `app/(auth)/login`, `/sign-up`, `/verify-email` with a shared branded layout and language switcher.
- **Known gaps (tracked in 5.2):** no email-invitation flow yet (join requests only); Better Auth's organization plugin is installed but not wired — adopting it vs. keeping the Company model is **ADR-002**; no `middleware.ts` — protection is per-page/per-route today.

#### 3.2.2 Tenant isolation machinery

The governing rules are already written down — `BAU_AI_AGENTIC_TENDER_ROADMAP.md` §6.3: every persisted object carries `tenantId` unless intentionally global; every repository query injects tenant scope server-side; the frontend, the LLM, tool arguments, and user prompts are never trusted to supply tenant scope.

What enforces them in code today:

- **`lib/ai/tenant/repository.ts`** — `TenantRepository<T>` wraps a collection so that every filter is rewritten with the tenant's id *last* (caller-supplied `tenantId` is overwritten), inserts are stamped, updates strip `tenantId`, and unscopable operations (`aggregate`, `distinct`, `bulkWrite`) are simply not exposed. `TenantId` has a private constructor — the only entry points are `forCompanyContext(context)` (from the session) and `forJobPayload()` (validated). **Unit-tested for cross-tenant denial** (`lib/ai/tenant/repository.test.ts`).
- **Vector search is tenant-filtered by construction**: `lib/ai/retrieval/vector.ts` (`companyVectorFilter` — exactly one tenant equality, no null branch), tested in `lib/ai/retrieval/company-filters.test.ts`, with a belt-and-braces re-filter after rank fusion (`hybrid.ts`) and `tenantId` declared as a filter field on the Atlas index (`lib/ai/db/search-indexes.ts`).
- **Agent state is tenant-keyed server-side**: LangGraph checkpoint threads are `clara:{tenantId}:{tenderId}`, derived from the session, never accepted from a client; no agent tool accepts a tenant id (`docs/AI_SUBSYSTEM.md`).
- **Typed tenant ownership**: `lib/ai/types.ts` marks each collection tenant-owned (`tenantId: ObjectId` — chat threads/messages/attachments, verdicts, fit recommendations, reports, match profiles/scores/runs) or global (`tenantId: null` — the shared tender corpus).
- **Structurally, the client can never reach the database** — there is no browser-side DB SDK at all. Every query is server code behind the session gate. This alone removes MVP1's largest attack surface (283 browser queries).

**Honest status:** `TenantRepository` is adopted in one subsystem (`lib/ai/fit/service.ts`); the other tenant-owned collections currently pass `tenantId` filters manually (convention, ~15 call sites, e.g. `lib/ai/agent/threads.ts`, `lib/ai/report/runs.ts`), and the 5 Mongoose models scope by convention too. **Closing that gap is the 4.11 commitment** — the pattern, tests, and rules already exist; adoption must become total and CI-enforced.

#### 3.2.3 Ingestion pipeline (notices)

Documented in `docs/INGESTION_WORKER.md` (476 lines) against the 976-line architecture plan (`MONGODB_TENDER_SEEDING_AND_INGESTION_ARCHITECTURE.md`).

- **Two live source adapters** (`lib/ingestion/sources/registry.ts`): **DE_BUND** — the German national data service (`oeffentlichevergabe.de` eForms ZIP exports, ETag-conditional, licence `dl-de-by-2.0`) and **TED** — the EU tenders API (v3 search, iteration pagination). Nine further source codes (NL/FR/ES/PL/UK×2/PT/IT/IE) are declared with config defaults but not yet implemented. Per-source config is **ops-owned and hot-reloadable** from Mongo (`source_configs`): live poll 300s/120s, daily reconciliation, rate limits, circuit-breaker threshold, 24-month backfill horizon.
- **Durable work queue on Redis Streams** (`lib/ingestion/queue/stream-queue.ts`, 366 lines): four priority streams (`live` → `reconciliation` → `enrichment` → `backfill`) + `dead-letter`; consumer groups with visibility-timeout reclaim and heartbeats; idempotent enqueue (3-day dedup keys); delayed-retry sorted set. (Deliberate, documented deviation from the plan's pub/sub — Streams give at-least-once delivery + replay.)
- **Failure-class retry policy** (`worker/retry-policy.ts`): `Retry-After` always wins; class-specific backoff (rate-limit ≥30s, Mongo-transient ≤60s, circuit-open ≥1–5min); default exponential ~30s→2h; max 5 attempts; only infrastructure failures count against the circuit breaker.
- **Transactional outbox** (`outbox/relay.ts` + `workers/outbox-relay.mts`): tender writes commit together with an `outbox_events` row; a Mongo **change stream** (with persisted resume token) plus a sweeper publishes to Redis pub/sub (`bauai:tenders:events`) — duplicates possible, loss impossible. Consumers: the live SSE feed (`app/api/tenders/events`) and the AI indexer.
- **Dead-letter queue with replay** (`pipeline/dead-letter.ts`): failures recorded with error class, attempts, parser version, and an S3 pointer to the raw payload (stack traces deliberately excluded — they can carry credentials); re-driven by selector (`source`, date range, `errorClass`, `parserVersion`, `runId`) via `npm run ingestion:replay`.
- **Six workers** (`workers/*.mts`): scheduler (Mongo leases; backfill pauses if live latency breaches its 300s SLO), N× ingest, outbox relay, status updater (deadline → `CLOSING_SOON`/`CLOSED` transitions), N× documents, AI indexer.
- **Observability built in**: a Prometheus registry (`lib/ingestion/observability/metrics.ts`) with per-worker `/metrics` + `/healthz` endpoints (ports 9464–9466 in compose), structured JSON logging, queue-depth/lag/DLQ-depth gauges.
- Zip-bomb guards (1.5 GB archive / 64 MB entry / 200k entries caps), sha256 content hashing, per-(source, mode) discovery cursors so live/reconciliation/backfill never fight.
- **Verification is script-based today** (`ingestion:smoke`, `ingestion:verify` — a 554-line persistence checker) — the vitest suite for ingestion is **not yet written** (tracked in 4.10/5.3; `docs/INGESTION_WORKER.md` says so itself).

A docs-first proof point: implementing against the written plan surfaced **two errors in the plan** (a geo-index that MongoDB rejects with error 171 — would have failed in production — and a polling assumption the German API cannot satisfy), both recorded with corrections in `docs/INGESTION_WORKER.md`.

#### 3.2.4 Document pipeline

- **8 portal resolvers** (`lib/ingestion/documents/registry.ts` + `resolvers/`), coverage measured against the live corpus of 26,267 tender-document links (`docs/DOCUMENT_RESOLVERS.md`): cosinex/DTVP family (8,285 refs), NetServer family (3,534), evergabe-online (1,984), RIB meinauftrag (1,658, headless render), Aumass (711), Staatsanzeiger (441), evergabe.de (registered; currently blocked by a JS wall — documented), plus a generic direct-file fallback. **63.2% of the corpus is covered by a platform resolver**; the non-resolvable portals are listed with reasons.
- Per-host rate limiting and concurrency caps, cookie-jar HTTP client, lazy Playwright/Chromium only where required (`documents/browser.ts`, env-gated).
- **Storage: S3** (raw payloads under `tenders/raw`, documents under `tenders/documents`) with presigned access; text extraction via `unpdf` (PDF) and `mammoth` (DOCX), ZIP unpacking, unsupported formats recorded `UNSUPPORTED` rather than failed; first 100k chars mirrored to Mongo for search.

#### 3.2.5 AI foundation (LangChain + LangGraph)

- **Embeddings**: Gemini `gemini-embedding-001`, 1536-d, L2-normalized, asymmetric task types, batched; every vector stamped with model/version/dimensions/`sourceHash` so re-runs are no-ops. Stored in **MongoDB Atlas Vector Search** — 4 indexes created by code (`lib/ai/db/search-indexes.ts`): notice vectors (9 filterable fields), chunk vectors (tenant-filterable), plus two Atlas Search (BM25) indexes with the `lucene.german` analyzer.
- **Chunking** (`lib/ai/chunking/`): section-aware, 500-token target/1200 max, one-sentence overlap, char-offset anchors — plus **German legal-reference extraction** (`§ 13 VOB/B`) keyword-indexed exactly, because embeddings can't tell § 13 from § 14.
- **Hybrid retrieval** (`lib/ai/retrieval/`): BM25 arm + vector arm in parallel (40 candidates each) → reciprocal-rank fusion (k=60) → pluggable reranker slot. Separate tenant-corpus entry point with strict filters.
- **Clara — a production LangGraph agent** (`lib/ai/agent/graph.ts`): a hand-rolled `StateGraph` (deliberately not `createReactAgent`) with history-repair guards for Gemini's strict tool-turn rules, a no-tools finalize node, and iteration caps. **20 tools** (`tools.ts`, 1,136 lines) spanning tender notice/overview/extractions/documents, company fit/report/verdict, similar-tender search, CPV lookup, workspace and company-document access — every tool label i18n-enforced by test. **Checkpointing in Mongo** via `@langchain/langgraph-checkpoint-mongodb`. **SSE streaming** with keep-alives, a hard turn timeout, and i18n error keys (`sse-turn.ts`); chat UI with citations, tender-reference cards, and verdict cards (`components/chat/`, 13 files).
- **Provider strategy**: deterministic pipelines route through a **model-role gateway** (`lib/ai/gateway/` — roles: embedding/extraction/reasoning/agent/report/match, each env-switchable `provider:model`); conversational roles have **all three LangChain bindings installed and implemented** (Gemini `thinkingConfig`, OpenAI `reasoningEffort`, Anthropic extended thinking) — switching is an env change, no code.
- **AI matching pipeline v2** (`lib/ai/match/`, 18 files): company profile → **facet generation** (multiple embedded facet vectors) → per-facet vector search → fusion with the deterministic CPV/geo/deadline ranking (`lib/tenders/relevance.ts`, weights 0.45/0.35/0.20) and a BM25 text arm → **LLM judge** on the head, batched with bounded concurrency. Every knob is env-tunable so a ranking regression rolls back without a deploy. Run lifecycle with heartbeats; surfaced in the UI with progress and per-tender match reasons. Includes **CPV derivation** from company text.
- **Structured extraction** (`lib/ai/extraction/`, 18 files): 7 schemas (deadlines, suitability criteria, award criteria, required proofs, contractual penalties, payment terms, alternative bids) where **every value carries a citation that is verbatim-verified** against the source (≤2 retries; `VERIFIED/UNVERIFIED/MISSING`), keyed by corpus hash for idempotent re-runs.
- Also built: document **classification** (German heuristics first, LLM fallback), bid/no-bid **verdict** and company-**fit** services, bilingual tender **overview**, **report generation** with HTML/DOCX/PDF renderers (`docx` lib + headless Chromium), company-document embedding, geocode cache.
- **AI job infrastructure**: 9 BullMQ queues (`lib/ai/queue/`) with 5 exponential-backoff attempts, zod-validated payloads, idempotency keys as job ids, and a resumable `ai_index_state` work ledger.
- **A committed eval baseline**: `evals/retrieval-baseline-2026-08-08.json`, produced by `npm run ai:eval` over 7 canonical bilingual questions × {keyword, vector, hybrid} × {de, en} measuring hit@1/5/10, MRR, latency. Current numbers: **hybrid DE hit@5 = 1.00 at 522 ms mean**; vector DE 1.00 / EN 0.917; keyword-only DE 0.833 / EN 0.167 (which is exactly why hybrid exists). Known not-built: extraction accuracy goldens, OCR, cross-encoder reranker (self-documented in `docs/AI_SUBSYSTEM.md`).

#### 3.2.6 Product UI

- **Tender workspace**: list with toolbar, saved filters (CRUD APIs), mode tabs, region switcher, **map view** (Google Maps + postal-centroid geocode cache); detail page with About/Schedule/Documents/AI tabs, extraction results, bilingual overview, decision actions, a floating **Clara assistant**, and a **report page** (on-demand, DOCX/PDF export).
- **Onboarding exists**: `app/(onboarding)/onboarding` + `components/onboarding/` + a 1,099-line localized catalog (`data/onboarding-catalog.ts`) + seed scripts (`db:seed:all` — onboarding options + the full CPV-2008 code list from the committed CSV).
- **Dashboard** with the agent roster (Clara live; Nova, Dora, Patrick, Dario slots) and membership-state handling.
- **13 settings pages** (company details, certifications, insurance, financial info, employees, documents with S3 presigned uploads, billing placeholder, Clara playbook, …) with profile-completion tracking.
- **i18n**: full EN + DE catalogs — 938 leaf keys each, **parity machine-enforced by a test** (`messages/parity.test.ts`).

#### 3.2.7 Quality, docs, and conventions

- **50 vitest files / 385 tests / 97 describe blocks** covering the agent graph and tools, extraction, matching (facets/fusion/judge/CPV), reports, retrieval (incl. tenant-safety), chunking, tenant repository, relevance ranking, i18n parity, config validation, SSE client. Gap: ingestion has 0 unit tests (script-verified today).
- **Docs shipped with the code** (`docs/`, 951 lines): `AI_SUBSYSTEM.md`, `INGESTION_WORKER.md` (with recorded plan corrections + deviations), `DOCUMENT_RESOLVERS.md` (live coverage numbers), `COMPANY_DETAILS_AND_UPLOADS.md`, `GLOSSARY.md` (German procurement ↔ English identifiers). Plus the two architecture plans (2,690 + 976 lines) the code was built against, and a README with the dev quickstart.
- **Conventions locked in**: all-English identifiers (the glossary maps German domain terms), `tenantId` everywhere, every AI feature behind the role gateway, structured logging, typed env config.

#### 3.2.8 Infrastructure & configuration

- **Web `Dockerfile`** (133 lines): 3-stage on `node:24-bookworm-slim`, BuildKit cache mounts, Next.js standalone output, non-root, healthcheck, and a **Chromium layer engineered to survive source changes** (commit `33d8023`) so rebuilds are fast.
- **Worker images**: `docker/Dockerfile.worker` (no browser) + `docker/Dockerfile.documents` (with Chromium), **built and pushed to GHCR by CI on every master push** (`.github/workflows/build-ingestion-image.yml`).
- **Compose stacks**: `docker/docker-compose.yml` — full local stack (MongoDB `atlas-local` 8.2 on **27018**, Redis 7 on **6380**, bootstrap + 6 worker services with metrics ports, log rotation, graceful stop); `deploy/docker-compose.vm.yml` — the single-VM production stack (external Mongo) from PR #13; plus prod/documents/redis variants, `deploy/cloudbuild.yaml`, and a Cloud Run runbook. Empty `deploy/coolify/` and `deploy/preview/` directories mark where the self-host PaaS work (4.2) lands.
- **Centralized, validated env config** (commit `56a08b2`): `lib/ingestion/config/env.ts` (fail-fast at worker start: Mongo/Redis/S3/TED/worker/scheduler/outbox/documents/limits) and `lib/ai/config/env.ts` (zod-validated, lazy so builds never crash, model-role map with format validation, secrets asserted only where used — with its own test). `.env.example` documents every variable.
- **Current CI gap, stated plainly**: the one workflow builds worker images only — **no test/lint/typecheck job runs in CI yet**, and there is no web-app image build. This is proposal item 4.10, not an omission we're hiding.

### 3.3 Architecture principles for the new codebase

1. **The client never touches the database.** All reads/writes are server-side, behind `getCompanyContext`. (Structural — already true.)
2. **Tenant isolation is enforced at the data-access layer** — `tenantId` on every tenant-owned collection, access through `TenantRepository`/scoped helpers, cross-tenant tests in CI (4.11).
3. **Every AI feature is a LangGraph graph or a gateway-routed pipeline, traced in Langfuse** once deployed (4.1). No stray LLM calls — MVP1 had them in 8 runtimes.
4. **Every external dependency sits behind an interface** — model roles are env-switchable today; the same applies to storage and email.
5. **Nothing exists without documentation.** Already practiced: the two big plans + 5 docs, including recorded corrections where implementation proved the plan wrong.
6. **The main branch is always releasable.** Protected `master`, mandatory reviews, green CI, preview validation (4.6–4.8).

---

## 4. What we are proposing

Two halves: a **technical stack** (4.1–4.4, 4.10–4.11) and an **engineering process** (4.5–4.9, 4.12). Both are required.

### 4.1 Agentic AI: one standard stack — LangChain + LangGraph + Langfuse

**Status:** LangChain + LangGraph **shipped and in production shape** in `bauai-nextjs` (Clara: `lib/ai/agent/graph.ts`, 20 tools, Mongo checkpoints, SSE; three provider bindings env-switchable). **Langfuse: not present anywhere yet (audited) — to deploy, self-hosted.**

**The rule:** *every* agentic/AI feature is a LangGraph graph or a gateway-routed pipeline, traced end-to-end in Langfuse. No ad-hoc LLM calls scattered through routes — MVP1's 8-runtime Gemini sprawl and its €12k incident are the counter-example this rule exists to prevent.

**Why Langfuse specifically:** full traces (inputs/outputs/intermediate steps), token usage and **cost per feature/customer**, latency, prompt versioning, eval datasets — and it is open source and **self-hostable on our VMs**, so traces of customer tender data never leave our infrastructure. When a customer says "the AI answered wrong yesterday", we open the trace instead of guessing. The pipelines are already structured for this (role gateway, run records with heartbeats, eval harness); Langfuse is the missing observability layer, not a re-architecture.

### 4.2 Infrastructure: self-hosted with Dokploy on our own VMs

**Current state (evidence):** worker images build to GHCR on every push; local + single-VM compose stacks exist and run (3.2.8); Cloud Run docs exist for the interim. **No staging, no previews, no managed panel yet** — and empty `deploy/coolify`/`deploy/preview` directories show this decision is already anticipated.

**The rule:** all our containers (Next.js app, workers, Redis, Langfuse, ONLYOFFICE) run on **our own VMs, managed through Dokploy** — Git-based deploys, Traefik load balancing + SSL, one-click databases, automated backups to S3-compatible storage, and **preview deployments per pull request** (which powers 4.6). MongoDB runs as **Atlas (managed) or self-hosted — ADR-001**, to be decided on backup/ops grounds; the search/vector indexes require Atlas or `atlas-local`-compatible deployments (`lib/ai/db/search-indexes.ts` enforces this at bootstrap).

**Why self-host:** control and independence; data residency for customers' tender/bid documents; flat VM pricing (we already carry the scars of usage-based surprise — €12k, 2.5); and we need VMs anyway for Langfuse + ONLYOFFICE. *(Honest framing: self-hosting makes uptime something we engineer — monitoring, backups, runbooks are part of this proposal, 4.10.)*

**Baseline topology (initial):** 2× app VMs behind Traefik, 1× data VM (Redis; Mongo if self-hosted per ADR-001), 1× services VM (Langfuse, ONLYOFFICE, workers). The worker fleet is already containerized and compose-defined — this is a lift, not a build.

### 4.3 Documents: self-hosted ONLYOFFICE with our AI on top

**Current state (evidence):** the new repo generates DOCX (`docx` lib) and PDF (headless Chromium) reports; MVP1 has the feature this proposal targets — the 63-file GAEB/doc-filler editor module (2.9) — plus `bauai-go`'s knowledge-base form-filling. **ONLYOFFICE: not present anywhere yet (audited).**

**The rule:** in-browser viewing/editing/filling of tender documents (DOCX/XLSX/PDF forms) is built on a **self-hosted ONLYOFFICE Docs server** embedded in our UI, with our agents doing the valuable part: pre-filling forms from tender data + the company knowledge base (porting the Go form-fill capability), suggesting answers, reviewing documents. We do not build an Office editor ourselves, and we do not keep maintaining the bespoke editor in MVP1. Customers' bid documents stay on our infrastructure (consistent with 4.2).

### 4.4 Authentication: Better Auth everywhere

**Status: shipped in `bauai-nextjs`** — sessions, email verification, Google/Microsoft SSO, and the Company membership model with role gates (evidence: 3.2.1; 30/38 API routes behind `getCompanyContext`).

**The rule:** *all* authentication and authorization context flows through Better Auth + `getCompanyContext`. No feature parses sessions its own way; no service ever trusts a client-supplied user or tenant id (the `bauai-go` middleware is the standing counter-example).

**Remaining decisions/work:** (a) **ADR-002** — adopt Better Auth's organization plugin vs. keep the hand-rolled Company model (recommendation: keep the Company model — it is live, tested against our flows, and organization-plugin migration touches every tenant read — revisit only if we need its invitation/permission machinery); (b) build the **email-invitation flow** (parity item, 5.2); (c) add a defense-in-depth `middleware.ts` so unauthenticated users are redirected before any page code runs; (d) migrate MVP1 users — Supabase Auth exports bcrypt hashes; Better Auth can import them, and where that fails the fallback is a verified-email password-reset campaign (rehearsed in Phase 2).

### 4.5 Process: JIRA Scrum with proper sprints

**The rule:** all work happens through JIRA Scrum. **If it isn't a ticket in a sprint, it isn't being worked on.** 2-week sprints; acceptance criteria written before development; estimates; demo on staging at review; retrospective. The shared Definition of Done (Appendix C) applies to every ticket.

**Why:** invisible side work is how MVP1 accumulated 5 parallel fetch-tenders implementations and 3 parallel onboarding systems. Scrum gives everyone — including non-engineers — visibility into what is being built, done, and next; retros fix the process instead of repeating it.

### 4.6 Environments: preview → staging → production

**The rule:** code reaches customers only through this pipeline. **No path to production skips staging**; no manual hotfixing on servers.

| Environment | Purpose | Deploy trigger | Data |
|---|---|---|---|
| **Preview** | Validate one branch in isolation | Automatic per PR (Dokploy previews) | Seeded/synthetic (`db:seed:all`, `seed:tenders`) |
| **Staging** | Prod-like validation, integration tests, demos, sign-off | Merge to `master` | Anonymized/representative |
| **Production** | Customers | Promotion of a staging-verified tagged release | Real |

**Why:** today the first environment that catches a bug is the customer — MVP1 has no staging and its CI doesn't even run on the active branch (2.6).

### 4.7 Git workflow: protected `master`, PRs, senior approval

**The rule:** `master` is protected; nobody pushes to it directly — including on `bauai-nextjs`, where the first 68 commits necessarily went straight to master during the solo bootstrap phase. That mode ends with this proposal's adoption.

1. Every change starts from a JIRA ticket on a branch (`feature/BAU-123-…`).
2. Merges only via PR with the Appendix B checklist.
3. Every PR requires **CI green (lint, typecheck, tests, build)** and **senior-developer approval** (branch protection + CODEOWNERS).
4. Small PRs are the norm.

### 4.8 Nothing merges without preview-environment validation

**The rule:** before merge, the author (and reviewer/QA where relevant) verifies the feature in its preview against the ticket's acceptance criteria — functionally, not "it compiles" — and the PR states what was tested. CI proves the build; preview proves the feature.

### 4.9 Documentation-first

**The rule:** documentation before code — an **ADR** (Appendix A) for any new technology/dependency/architectural change, and a **short design doc** for every feature, plus runbooks for anything operational.

**Why it works — we have local proof:** the new repo was built docs-first (two architecture plans totalling 3,666 lines), and the process caught two would-be production bugs on paper→implementation contact (the invalid geo index, the impossible polling assumption — 3.2.3), recording corrections instead of shipping surprises. Contrast: MVP1 gitignores `*.md` and keeps its operational wisdom in `deploy.txt` files (2.6).

### 4.10 Additional guardrails (the "etc." made explicit)

- **CI/CD on every PR: lint, typecheck, `npm run test`, build — required to merge.** (Today CI only builds worker images — the 385 existing tests run on nobody's machine but ours. Wiring this is a day of work and is listed in Phase 1.)
- **Write the ingestion test suite** — the one large subsystem with 0 unit tests (script-verified today, 3.2.3).
- **Versioned schema/index changes only** — Mongo indexes and search indexes are already created by code (`lib/ai/db/search-indexes.ts`, bootstrap scripts); keep it that way, no console-created indexes.
- **Secrets management:** per-environment secrets in Dokploy config — never in git, never in images. (The audit found both anti-patterns live in the old stack — 2.3. Rotation is a Phase-0 action, not a someday.)
- **Backups with tested restores:** Mongo (Atlas snapshots or self-managed dumps per ADR-001) + S3 versioning, with a **quarterly restore drill**.
- **Monitoring and alerting:** the workers already expose Prometheus `/metrics` + `/healthz` (3.2.3) — add scraping + dashboards + alerts, plus self-hosted Sentry (app errors) and uptime checks.
- **Incident process:** severity levels, runbook, **blameless postmortems** whose action items become tickets. (The €12k incident produced a comment in a deploy.txt; it should have produced budgets, alerts, and a postmortem.)
- **Conventional commits + tagged releases** — rollback is a redeploy of the previous tag.

### 4.11 Security baseline: tenant isolation by default (MongoDB)

v1 of this document promised "RLS by default" — that was written for a Postgres that doesn't exist in the new stack. The commitment stands; the enforcement mechanism is MongoDB-appropriate, and most of it already exists (3.2.2):

1. **Every tenant-owned collection carries `tenantId`, typed as such** (`lib/ai/types.ts`), per the roadmap §6.3 rules. Global reference data (the shared tender corpus, CPV codes) is explicitly typed global.
2. **All tenant-data access goes through the scoping layer** — `TenantRepository` (which makes cross-tenant access unrepresentable at the call site) or an equivalently tested scoped helper. **Commitment: retire the ~15 remaining raw-collection call sites and the convention-scoped Mongoose paths; a PR that queries a tenant collection without the scoping layer is rejected (Appendix B item).**
3. **Tenant scope is always derived server-side from the Better Auth session** (`TenantId.forCompanyContext`) or a validated job payload — never from the client, the LLM, or tool arguments. Agent checkpoints and vector-search filters already comply.
4. **Cross-tenant isolation tests run in CI** — the repository and vector-filter denial tests exist today (`repository.test.ts`, `company-filters.test.ts`); CI must run them on every PR (4.10) and every new tenant collection ships with one.
5. **The client never holds a database credential of any kind** — structural in Next.js server-side data access; this is the property MVP1 fundamentally lacks (283 browser queries against RLS-less tables, 2.3).

### 4.12 Summary — proposal at a glance

| # | Proposal | Type | Status (evidence-checked 2026-08-11) |
|---|---|---|---|
| 1 | All agentic AI via LangChain + LangGraph + Langfuse | Stack | LC/LG **shipped** (Clara live, 3 providers switchable); Langfuse **to deploy** |
| 2 | Self-host via Dokploy on our VMs, multi-VM + LB | Infra | Images in GHCR by CI; compose stacks exist; Dokploy/staging/previews **to set up**; Mongo hosting = ADR-001 |
| 3 | Self-hosted ONLYOFFICE for AI document filling | Stack | **Not present**; DOCX/PDF renderers exist; doc-filler + Go form-fill to port onto it |
| 4 | All authentication via Better Auth | Stack | **Core shipped** (sessions, verification, SSO, company membership); invitations + middleware pending; org-plugin = ADR-002 |
| 5 | JIRA Scrum, 2-week sprints, acceptance criteria | Process | To adopt |
| 6 | Preview → staging → production pipeline | Process/Infra | To set up (Dokploy previews) |
| 7 | Protected `master`; PRs with senior approval | Process | To enforce (solo-bootstrap mode ends now) |
| 8 | Mandatory preview validation before merge | Process | To enforce |
| 9 | Documentation/ADR before any feature or tech | Process | **Already practiced** in new repo (5 docs + 2 plans); formalize as ADRs |
| 10 | CI test gates, migrations-only schema, secrets, backups, monitoring, incidents | Process/Infra | Partial (image CI, metrics endpoints, env validation exist); test gates + backups + alerting **to set up** |
| 11 | Tenant-isolation-by-default + CI isolation tests | Security | **Machinery + tests exist**; total adoption + CI wiring **to enforce** |

---

## 5. Migration plan

### 5.1 Principles

- **Freeze, don't fork.** From Phase 0, `mvp1-bauai` and `bauai-go` receive **critical and security fixes only** (three of those are already queued — 2.3).
- **Parity is measured, not felt.** The matrix below is the single "are we done porting" checklist.
- **Tenders are re-ingested, not migrated.** The new pipeline rebuilds the tender corpus from the sources themselves (24-month backfill horizon configured). Only *tenant* data migrates — users, companies, memberships, decisions, documents, billing. This shrinks the risky ETL surface dramatically.
- **Preserve the domain assets** (2.9): CPV/NUTS data (already seeded from the committed CSV), translations (already re-established), billing logic (to port), doc-filler domain knowledge (to port onto ONLYOFFICE).
- **Data migration is rehearsed** — scripted, idempotent, dry-run in staging with validation counts before touching production.
- **Cutover is reversible** — the old system stays read-only-available until the bake period ends.

### 5.2 Feature Parity Matrix (from the audit — owners/tickets to assign in Phase 0)

Legend: ✅ done in `bauai-nextjs` · 🔶 partial / shell only · ❌ not started · 🗑️ propose to drop (product decision)

| # | Feature | Where it lives today | Status in `bauai-nextjs` (evidence) |
|---|---|---|---|
| 1 | Auth: email+password, verification, OAuth | Supabase Auth + 225-line `AuthProvider` | ✅ `lib/auth.ts` — verify-mandatory, Google/Microsoft |
| 2 | Company (tenant) model, roles | `companies`/`memberships` (no RLS) | ✅ `models/company.ts` members + admin/member + `getCompanyContext` |
| 3 | Join-company approval | `approve-user` edge fn | ✅ `membershipRequests[]` + API + UI |
| 4 | Member email invitations | — (approval only) | ❌ build (ADR-002 decides mechanism) |
| 5 | Onboarding | 1,589-line modal + Otto + tutorial (3 systems) | ✅ dedicated route + 1,099-line catalog + seeds; QA against old flow pending |
| 6 | German notice ingestion | `tender-processor-server` + 5 edge-fn variants | ✅ DE_BUND adapter (ETag, hot-reloadable config) |
| 7 | TED (EU) ingestion | `run-ted-daily-pipeline` | ✅ TED v3 adapter |
| 8 | Further EU portals (NL/FR/ES/PL/UK/PT/IT/IE) | — | 🔶 9 source codes declared, adapters not implemented |
| 9 | Tender list, filters, search | `TenderFilters.tsx` (2,836 LOC), 283 browser queries | ✅ tenders workspace + saved filters + Atlas Search (german analyzer) |
| 10 | Map view + geocoding | `geocoding.ts` + Go geocode jobs | ✅ map UI + `geo_cache` postal centroids |
| 11 | Tender detail + AI analysis | `TenderAgentInterface.tsx` (2,315 LOC) + analysis fn (1,542 LOC) | ✅ detail tabs + overview + extractions + AI tab |
| 12 | AI company↔tender matching | `company-tender-processor` + Go warmup + `tender_predictions` | ✅ match v2 (facets → vector → fusion → judge) + progress UI |
| 13 | Fit score / bid-no-bid verdict | Go `/api/tender-fit/stream` | ✅ `lib/ai/fit` + `lib/ai/verdict` |
| 14 | Tender short summary | Go `tender-short-summary` | ✅ `lib/ai/overview` (bilingual, one call) |
| 15 | Structured extraction (deadlines, criteria, …) | scattered (Go fixed-output, soil-params fn) | ✅ 7 cited+verified schemas; extend per product need |
| 16 | Portal document download | `tender-document-downloader` + `playwright-server` | ✅ 8 resolvers, 63.2% corpus coverage, blockers documented |
| 17 | Document text extraction + embeddings | `tender-document-extractor` (Tika) + Go upload path | ✅ unpdf/mammoth + chunker + Gemini embeddings (no Tika dependency) |
| 18 | Document Q&A / chat-with-tender | `tender-document-qa` + Dora/Go | ✅ Clara tools + hybrid retrieval + citations |
| 19 | General chat (threads, history) | `generalAgent` pages + `chat_sessions` (42 query sites) + Go Dora endpoints | ✅ chat workspace + thread APIs + Mongo checkpoints |
| 20 | Nova scope-comparison agent | `nova-agent` 3,498 LOC ×2 copies | ❌ port (dashboard slot exists; roadmap §23–28) |
| 21 | Doc-filler / GAEB editor | `src/features/doc-filler` (63 files) | ❌ port onto ONLYOFFICE (4.3) |
| 22 | Form filling from company KB | Go `/api/form-fill` | ❌ port onto ONLYOFFICE + Clara |
| 23 | Company settings / master data | `company-settings` (`useCompanyData` 1,867 LOC) | ✅ 13 settings pages + completion tracking |
| 24 | Company document KB | `documents`/`extracted_document` | ✅ S3 uploads + embed pipeline + Clara company tools |
| 25 | Kanban / tender workspace board | kanban pages + `work_space_tender` | 🔶 decisions model + route shell; board UI to build |
| 26 | Notifications | `useNotifications` + `send-tender-notifications-v3` | 🔶 route shell only |
| 27 | Email digests / alerts | `send-daily-tender-digest`, trial emails | ❌ build on Resend (already wired for auth mail) |
| 28 | Billing / Stripe | 892-LOC webhook + plans/addons/gates/audit | ❌ **largest unported system** — port with care |
| 29 | CAN winner / competitor intelligence | `can-winner-profiles`, `competitor_awards`, weekly digest | ❌ / 🗑️ product decision |
| 30 | Outbound company emails (Apollo export) | `can-company-emails` | ❌ / 🗑️ product decision |
| 31 | ChatGPT token integration (`clara-public`) | edge fns + `chatgpt_api_tokens` | ❌ / 🗑️ product decision |
| 32 | HubSpot sync | `sync-hubspot` fn | ❌ / 🗑️ product decision |
| 33 | Evergabe scraper → XLSX email report | GH Action cron + committed creds | 🔶 superseded by evergabe-online resolver; evergabe.de itself JS-walled (documented) |
| 34 | Legacy ERP modules (inventory, warehouses, Gantt, …) | README scope + ~20 tables | 🗑️ confirm drop with product |
| 35 | i18n DE/EN | 11,260 LOC translations | ✅ 938-key catalogs, parity-tested |
| 36 | Guided tour / tutorial system | `TutorialOverlay` + driver.js + `GuidedTour` | 🔶 shell route; product decision on scope |

### 5.3 Phases

**Phase 0 — Freeze, secure, inventory (Week 1)**
Feature freeze on `mvp1-bauai` + `bauai-go`. **Execute the five security actions in 2.3 (key rotations, log-line removal, Go auth fix) immediately.** Assign owners/tickets to every parity-matrix row; product decides the ❌/🗑️ rows (28–34, 36). Set up JIRA, the migration epic, and this document's rules.

**Phase 1 — Infrastructure & CI gates (Weeks 1–2, parallel)**
Provision VMs; install Dokploy; Traefik + SSL; staging + per-PR previews. Decide ADR-001 (Mongo hosting) and stand up Redis + Langfuse + ONLYOFFICE. **Wire the missing CI jobs (lint, typecheck, `npm run test`, web build) and branch protection** — the tests exist, they just don't gate anything yet. Monitoring: scrape the existing worker `/metrics`, add Sentry + uptime + alerts. Backup schedule + first restore drill.

**Phase 2 — Hardening & migration rehearsal (Weeks 2–4)**
Verify the built core against real-shaped data in staging. **Complete tenant-isolation adoption** (4.11: retire raw call sites, isolation tests in CI). Write the ingestion vitest suite. Build the invitation flow + `middleware.ts`. Instrument agents/pipelines with Langfuse. Write and dry-run the **tenant-data migration scripts** (idempotent, counts + checksums): users & password hashes (Supabase → Better Auth import; fallback reset campaign), companies + memberships → `Company.members`, profiles → `AccountProfile`, saved/disliked/workspace state → `TenderDecision`, company documents (Supabase Storage → S3 + re-embed), Stripe customer/subscription re-linking, chat history (product decides: migrate or start fresh). Rehearse rollback.

**Phase 3 — Feature porting (Weeks 3–8, sprint-driven)**
Port the remaining matrix rows as normal sprint tickets: **billing (28)** first, then notifications/digests (26–27), kanban board (25), ONLYOFFICE + doc-filler + form-fill (21–22), Nova (20), additional source adapters (8) as product priorities dictate. Each with design note, PR, preview validation, staging verification.

**Phase 4 — Pilot cutover (Week 9)**
Production tenant-data migration in a planned window; tender corpus already re-ingested and warm. Internal team + 1–3 friendly customers on `bauai-nextjs` production. Old system read-only. Monitor errors, Langfuse traces, ingestion metrics; fix fast.

**Phase 5 — Full cutover & decommission (Weeks 10–12)**
Migrate remaining customers; switch DNS. Bake 2–4 weeks with MVP1 in cold standby. Then archive `mvp1-bauai` + `bauai-go` (read-only), tear down their infra (Cloud Run services, edge functions, Vercel project), and hold the migration retrospective.

*Timeline is indicative — re-estimate in Phase 0 planning. The phase order and gates are the proposal.*

### 5.4 Cutover & rollback

- Planned, announced maintenance window with a written runbook (who, what, order, verification).
- **Go/no-go checklist:** parity matrix rows all ✅-verified in staging; bug-inventory rows re-tested; backups taken and restore-tested; rollback rehearsed; Langfuse tracing live; security actions from 2.3 confirmed done.
- **Rollback plan:** DNS reverts to MVP1 (read-only but startable); writes since cutover reconciled from the new system's Mongo. Triggers and owners named in the runbook before cutover day.
- **Auth-specific risk** is handled in Phase 2 rehearsal: if hash import fails for a cohort, those users get a branded reset email — never a silent lockout.

---

## 6. Engineering rules going forward (the contract)

1. `master` is protected. Every change goes through a PR with **senior-developer approval** and green CI. No exceptions, no direct pushes.
2. Nothing merges without **functional validation in its preview environment** against acceptance criteria.
3. Nothing reaches customers without passing through **staging**.
4. Every tenant-owned collection carries `tenantId`, is accessed **only through the tenant-scoping layer**, and has a **cross-tenant isolation test in CI**. Tenant scope derives from the session or a validated job — never from a client, an LLM, or a tool argument.
5. Every AI feature is a **LangGraph graph or gateway-routed pipeline, traced in Langfuse** — no stray LLM calls.
6. Every new feature or technology starts with a **design doc / ADR**, reviewed before implementation.
7. All work is a **JIRA ticket in a sprint** with acceptance criteria and the shared Definition of Done.
8. Schema and index changes happen only through **versioned, code-defined migrations/bootstraps** — never console edits on live databases.
9. Incidents get **blameless postmortems** whose action items become tickets. (Cost incidents included — budgets and alerts, not comment-fences.)
10. After cutover, `mvp1-bauai` and `bauai-go` are **frozen and archived**. All development happens in `bauai-nextjs`. No exceptions.

---

## 7. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Already-exposed secrets are abused before rotation | Medium | Critical | **Phase-0 day-one actions (2.3)** — rotate service-role key + PAT, purge history, fix Go auth. Independent of the migration decision |
| Migration takes longer than estimated | Medium | Medium | Measured 36-row parity matrix; the riskiest subsystems are already built and running; sprint-based re-estimation; MVP1 remains as fallback |
| Supabase→Better Auth user migration friction (hash import) | Medium | Medium | Phase-2 rehearsal on a real export; fallback = branded reset-email campaign; never silent lockout |
| Billing port (Stripe) breaks paying customers | Medium | High | Port webhook + plans against Stripe test clocks in staging; reconcile customer/subscription ids before cutover; keep MVP1 webhook alive during bake |
| Feature freeze frustrates product/customers | Medium | Medium | Freeze scoped to critical/security fixes; the freeze is what makes the migration short |
| Self-hosting ops burden | Medium | High | Dokploy automates deploys/SSL/previews; metrics endpoints already exist — add scraping/alerts (4.10); runbooks; start with 3–4 VMs |
| Tenant-data migration errors | Low–Med | High | Idempotent scripts, staging dry-runs, counts/checksums, tested restores, rehearsed rollback; tender corpus is re-ingested, not migrated |
| Cross-tenant leak in the new system | Low | Critical | 4.11: scoping layer + server-only DB access + CI isolation tests; the enforcement machinery already exists and is unit-tested |
| Historical data older than the 24-month backfill horizon | Low | Medium | Confirm product need in Phase 0; horizon is config (`backfillHorizonMonths`), or one-off import from MVP1 for CAN archives if row 29 survives |
| Knowledge concentration (new repo built fast by few hands) | Medium | Medium | Docs already unusually strong (5 docs + 2 plans); pair on first ticket per area; docs-first rule keeps it that way |
| Process feels heavy / slows delivery | Medium | Medium | The process replaces the measured firefighting tax (2.4–2.6); retros trim any step not earning its keep |

---

## 8. Success metrics

Judged on numbers, comparing a 4-week pre-cutover baseline with 4–8 weeks after:

- **Production bugs per week** (target: sustained, significant reduction)
- **Regression rate** — bugs caused by unrelated changes (target: near zero; this is the "spaghetti metric")
- **Ingestion success rate** and time-to-diagnose (target: >99%; minutes via DLQ + metrics + traces. Baseline exists: DLQ depth, queue lag, and per-stage metrics are already exported — 3.2.3)
- **Document resolver coverage** (baseline today: **63.2%** of 26,267 docs — `docs/DOCUMENT_RESOLVERS.md`; target: raise via new resolvers, tracked per portal)
- **Retrieval quality** — the committed eval baseline (hybrid DE hit@5 1.00 @ 522ms; EN keyword 0.167 → hybrid target ≥0.9) re-run on every retrieval change (`npm run ai:eval`)
- **Onboarding completion** without manual intervention (target: fully self-serve)
- **Cross-tenant access findings** in tests/audits (target: zero, enforced by CI isolation tests)
- **Lead time** (ticket → production) and **deployment frequency / rollback count** (frequent, boring deploys)
- **AI observability**: % of agent runs traced in Langfuse (target: 100%) and **cost per feature/customer** visible (the €12k class of incident becomes structurally impossible to miss)
- **Uptime** ≥99.9% monthly, measured by our own monitoring

---

## 9. FAQ / anticipated objections

**"Why not just fix `mvp1-bauai` incrementally?"**
We tried — in writing. The February 2026 internal refactoring plan (2.7) proposed exactly the right things (typed access layer, feature modules, query layer) and did not converge after six months under feature pressure: the access-client stayed a stub, and the 283 ad-hoc browser queries are still there. The defects are structural (no isolation boundary, 12 deployables, spaghetti data access), and the clean replacement **already exists and runs**. Finishing the migration is the cheaper path.

**"Why MongoDB instead of Postgres with RLS?"**
That decision is made and documented (`MONGODB_TENDER_SEEDING_AND_INGESTION_ARCHITECTURE.md`): one database for the tender corpus + tenant data, with Atlas Search + Vector Search built in (both already power search, matching, and retrieval — 3.2.5), transactions + change streams powering the outbox. What we give up — a database-level RLS backstop — MVP1 never actually had (29 tables without RLS, including `companies` and `memberships`; 673 service-role bypasses). What we gain structurally: the browser can never query the database at all, and tenant scope is injected server-side by a tested repository layer (4.11). Isolation enforced in one audited seam beats isolation half-configured across 122 tables and bypassed by every backend.

**"Isn't a monolith a step backwards?"**
No — see 3.1. Our problem was never "one service"; it was zero boundaries across 12 deployables. A modular monolith with explicit seams (`lib/ingestion`, `lib/ai`, `lib/tenders`) is the standard recommendation at our size, and extraction later remains possible from clean seams.

**"Why self-host instead of a managed platform?"**
Data residency for customers' tender documents, cost predictability (we have a documented €12k usage-bill scar), independence from third-party outages — and we need VMs anyway for Langfuse and ONLYOFFICE. Dokploy gives us the platform ergonomics (git deploys, previews, SSL, backups) on hardware we control.

**"Will all this process slow us down?"**
Each feature gains small overhead (ticket, doc, review, preview check). In exchange we delete the measured hidden tax: manual backfill archaeology (41 scripts), debugging without traces, re-fixing regressions CI never caught, and 3,500-line agents maintained twice. Net velocity goes up — and becomes predictable, which is what sprints require.

**"What happens to `mvp1-bauai` and `bauai-go`?"**
Security-patched and feature-frozen from Phase 0, fallback during cutover, then archived read-only. Their domain knowledge (2.9) is carried forward deliberately: CPV/NUTS data is already seeded, i18n already re-established, billing and doc-filler are explicit parity rows, and `bauai-go`'s fit/summary/extraction capabilities already have superior counterparts (matrix rows 13–15, 17).

---

## 10. Decision and next steps

**We are asking the team to agree to:**

1. Adopt `bauai-nextjs` as the sole platform going forward, with full migration per Section 5.
2. Feature-freeze `mvp1-bauai` + `bauai-go` (critical/security fixes only) starting immediately — and execute the 2.3 security actions this week regardless of anything else.
3. Adopt the engineering contract in Section 6 — PR reviews with senior approval, the environment pipeline, JIRA Scrum, docs-first, and tenant-isolation-by-default.

**Immediate next steps once agreed:**

| # | Action | Owner | When |
|---|---|---|---|
| 0 | **Rotate exposed keys; purge `.env` from history; fix Go auth; remove the key-logging line** | [Owner] | **This week, before anything else** |
| 1 | Circulate this doc; collect comments; decision meeting | Santhosh | This week |
| 2 | Create JIRA project, migration epic, first sprint | Rishi | Week 1 |
| 3 | Assign owners to all 36 parity rows; product decides rows 28–34, 36 | Whole team | Week 1 |
| 4 | Wire CI test/lint/typecheck gates + branch protection on `master` | [Owner] | Week 1 |
| 5 | Provision VMs; install Dokploy; staging + previews | [Owner] | Weeks 1–2 |
| 6 | Deploy Langfuse + ONLYOFFICE; decide ADR-001 (Mongo hosting) and ADR-002 (org plugin) | [Owner] | Weeks 1–2 |
| 7 | Tenant-isolation adoption pass + isolation tests in CI | [Owner] | Weeks 2–3 |
| 8 | Tenant-data migration scripts + staging dry run (incl. auth-hash rehearsal) | [Owner] | Weeks 2–4 |

---

## Appendix A — ADR (Architecture Decision Record) template

```markdown
# ADR-NNN: <Title>
- Status: Proposed | Accepted | Superseded by ADR-XXX
- Date: YYYY-MM-DD
- Authors:

## Context
What problem are we solving? What constraints apply (tenancy, self-hosting, cost, security)?

## Decision
What are we doing, concretely?

## Alternatives considered
Options with honest pros/cons, and why they were rejected.

## Consequences
Positive, negative, and neutral outcomes. Operational impact (deploys, backups, monitoring).
Security/tenancy impact (tenant scoping? new data flows?). Exit strategy if we need to reverse this.
```

Queued ADRs from this proposal: **ADR-001** MongoDB hosting (Atlas vs self-hosted on our VMs), **ADR-002** Better Auth organization plugin vs the shipped Company membership model.

## Appendix B — Pull request checklist

```markdown
- [ ] Linked JIRA ticket with acceptance criteria
- [ ] Small, focused diff; conventional commit title
- [ ] CI green: lint, typecheck, tests, build
- [ ] New/changed tenant-owned collections: `tenantId` field + access via the tenant-scoping
      layer (TenantRepository or documented equivalent) + cross-tenant isolation test
- [ ] No secrets, keys, or credentials in the diff (we have two live counter-examples; never again)
- [ ] DB/index changes are code-defined (bootstrap/migration), no console edits
- [ ] AI changes: LangGraph graph or gateway-routed; traced in Langfuse; eval re-run if retrieval/ranking changed
- [ ] i18n: EN + DE keys added (parity test will fail otherwise)
- [ ] Validated functionally in the preview environment (state what was tested)
- [ ] Docs updated (feature doc / ADR / runbook as applicable)
- [ ] Senior developer approval
```

## Appendix C — Definition of Done

A ticket is **Done** only when: acceptance criteria are met and demonstrated; code is merged to `master` via an approved PR with green CI; the feature was validated in preview and verified on staging; relevant tests exist (including tenant-isolation tests where applicable); documentation is updated; monitoring/tracing is in place for anything operational or AI-driven; and no known critical defects remain.

## Appendix D — Verify this document yourself

All against `bauai-nextjs` @ `56a08b2` unless noted. Local stack: `docker compose -f docker/docker-compose.yml up -d mongo redis` (Mongo on **27018**, Redis on **6380** — non-default on purpose), then `npm run dev` + `npm run worker:ai`.

| Claim | How to verify |
|---|---|
| 385 tests / 50 files pass | `npm run test` |
| Retrieval eval + baseline | `npm run ai:eval`; compare `evals/retrieval-baseline-2026-08-08.json` |
| Ingestion end-to-end | `npm run ingestion:bootstrap` → `ingestion:smoke` → `ingestion:verify` |
| DLQ replay exists | `npm run ingestion:replay -- --help` (`scripts/ingestion-replay-dlq.mts`) |
| Clara agent runs | `npm run ai:agent:smoke` |
| Matching pipeline | `npm run ai:match` |
| Worker metrics | `curl localhost:9464/metrics` with the compose stack up |
| Resolver coverage 63.2% | `docs/DOCUMENT_RESOLVERS.md` (dated corpus counts) |
| Tenant scoping machinery | `lib/ai/tenant/repository.ts` + its test; `lib/ai/retrieval/company-filters.test.ts` |
| MVP1 RLS counts | grep `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY` in `mvp1-bauai/supabase/migrations/` |
| MVP1 browser queries | grep `\.from(` under `mvp1-bauai/src/` |
| Go auth gap | `bauai-go/internal/middleware/auth.go` |

Key entry points for reviewers: `lib/auth.ts` · `lib/company/context.ts` · `models/company.ts` · `lib/ingestion/{sources,queue,outbox,pipeline,documents}` · `workers/` · `lib/ai/{agent,retrieval,match,extraction,report,tenant}` · `lib/ai/db/search-indexes.ts` · `docs/` · `deploy/`.

---

*Prepared by Santhosh & Rishi — August 2026. v2 evidence-audited 2026-08-11 against `mvp1-bauai@31c6746`, `bauai-go` (latest), and `bauai-nextjs@56a08b2`. Comments and edits welcome before the decision meeting; this document lives in the repo under `docs/migration-docs/`.*
