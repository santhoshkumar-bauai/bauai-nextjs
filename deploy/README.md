# Ingestion deployment (GCP)

> **Two paths.** This file is the **VM / docker-compose** path — the full always-on
> pipeline (scheduler + ingest + outbox + documents) with Redis. For the **cheapest**
> setup — scheduled Cloud Run Jobs, no Redis, nothing running while idle — see
> [`README-cloudrun.md`](README-cloudrun.md). The Cloud Run path is the better fit for
> "seed once, then a daily job that catches new tenders."

Runs the tender-ingestion workers from the **prebuilt GHCR image** (built by
[`.github/workflows/build-ingestion-image.yml`](../.github/workflows/build-ingestion-image.yml))
against your **existing MongoDB** + a **Memorystore Redis** (or the local Redis overlay,
[`docker-compose.redis.yml`](docker-compose.redis.yml)), storing files in **GCS**.

```
deploy/
├── README.md                 ← this runbook
├── .env.example              ← copy to .env, fill in (gitignored)
└── docker-compose.prod.yml   ← workers + publishers, grouped for extension
```

The image is one binary with many entrypoints; the compose service picks the worker.
Adding a worker/publisher later = a `workers/<name>.mts` file + a service block under the
matching heading in the compose. Nothing else changes.

---

## 0. Prerequisites

- **MongoDB must be a replica set** (transactions + change streams). Standalone will not
  work — `rs.initiate()` a single-member set if needed.
- A GCP project, and a VM (or GKE) **in the same VPC** as Memorystore.

## 1. Object storage — GCS via the S3-compatible API

The workers speak S3 with path-style addressing, which GCS interop supports. You need a
bucket and an **HMAC key** (S3 access id + secret).

```bash
PROJECT=your-project ; REGION=europe-west3 ; BUCKET=bauai-tenders

gcloud storage buckets create gs://$BUCKET --location=$REGION --project=$PROJECT

# A dedicated service account with object access to the bucket:
gcloud iam service-accounts create bauai-storage --project=$PROJECT
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
  --member="serviceAccount:bauai-storage@$PROJECT.iam.gserviceaccount.com" \
  --role=roles/storage.objectAdmin

# The HMAC key = your S3 credentials:
gcloud storage hmac create bauai-storage@$PROJECT.iam.gserviceaccount.com --project=$PROJECT
#   accessId  -> S3_KEY_ID
#   secret    -> S3_APPLICATION_KEY
```

Then in `deploy/.env`:

```
S3_ENDPOINT=https://storage.googleapis.com
S3_REGION=europe-west3          # bucket location; "auto" also works
S3_BUCKET_NAME=bauai-tenders
S3_KEY_ID=<accessId>
S3_APPLICATION_KEY=<secret>
```

## 2. Redis — Memorystore

```bash
gcloud redis instances create bauai-ingestion \
  --size=1 --region=$REGION --redis-version=redis_7_0 --tier=standard
gcloud redis instances describe bauai-ingestion --region=$REGION --format='value(host)'
#   -> REDIS_URL=redis://<that-ip>:6379
```
It's the durable job queue, so keep the Standard (HA) tier and `noeviction` semantics.

## 3. Get the image from GitHub (no Artifact Registry)

Push to `master`/`main` (or run the workflow manually) → the Action publishes
`ghcr.io/bau-ai/bauai-nextjs/tender-ingestion:latest`.

On the deploy host, authenticate to GHCR once (the package is private by default):

```bash
# A GitHub PAT with read:packages — or make the GHCR package public and skip this.
echo $GHCR_PAT | docker login ghcr.io -u <github-username> --password-stdin
```

> Prefer a fine-grained PAT or a machine user for this — do **not** reuse a token that
> also has repo write access, and never bake tokens into git remotes.

## 4. Configure & run

```bash
cd deploy
cp .env.example .env          # then fill in Mongo/Redis/GCS values
docker compose -f docker-compose.prod.yml pull

# a) one-shot bootstrap FIRST (indexes, collections, source configs)
docker compose -f docker-compose.prod.yml run --rm bootstrap

# b) seed historical tenders (bulk, direct to Mongo, no Redis)
docker compose -f docker-compose.prod.yml run --rm seed -- --from 2026-01-01

# c) start the continuous stack (scheduler + ingest + outbox + status + documents)
docker compose -f docker-compose.prod.yml up -d --scale ingest=4 --scale documents=2
```

Order is **bootstrap → seed (and/or scheduler+ingest) → documents**:

- **Seeding** creates tender rows — `seed` (bulk backfill) and/or the live `scheduler`+`ingest` pair.
- The **runner** that downloads files is the `documents` worker (Mongo is its queue; ~11.7k docs are already PENDING).
- The `fetch` tool service is a bounded one-shot alternative: `run --rm fetch -- --limit 500`.

## 5. Logs, health, scaling

```bash
docker compose -f docker-compose.prod.yml logs -f ingest documents
docker compose -f docker-compose.prod.yml up -d --scale ingest=6      # add throughput
```
Each worker serves `/healthz` + Prometheus metrics on `:9464` (scheduler) / `:9465` (outbox).

## Notes

- **Headless resolvers (rib-meinauftrag):** the default alpine image has no Chromium, so
  on the base stack keep `DOCUMENTS_BROWSER_ENABLED=false` (rib rows skip cleanly). To
  enable it, run the `documents` service on the Chromium image
  ([docker/Dockerfile.documents](../docker/Dockerfile.documents), published by the same
  Action as `tender-ingestion-documents`) using the overlay:

  ```bash
  docker compose -f docker-compose.prod.yml -f docker-compose.documents.yml up -d
  ```

  The overlay swaps only the `documents` service onto the browser image, forces
  `DOCUMENTS_BROWSER_ENABLED=true`, and gives Chromium a 1 GB `/dev/shm`. Every other
  worker stays on the small alpine image. Keep `DOCUMENTS_BROWSER_ENABLED=false` in
  `.env` — the overlay overrides it for `documents` only.
- **GKE instead of a VM:** map each service here to a Deployment (scheduler/outbox/status
  = 1 replica, ingest/documents = scaled), run `bootstrap` as a Job, and put `.env` in a
  Secret. Same image, same order.
