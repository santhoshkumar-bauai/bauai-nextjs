# Ingestion on Cloud Run (minimal cost)

Runs the pipeline as **Cloud Run Jobs on a schedule** — no Redis, no VMs, nothing
running while idle. You pay only for the minutes each job runs (a few cents/day) plus
GCS storage. This is the cheapest way to get tenders + their documents into GCS.

For the always-on live pipeline (`scheduler`/`ingest`/`outbox` over Redis) use the VM
path in [`README.md`](README.md) instead — on Cloud Run that tier needs Memorystore + a
Serverless VPC connector + always-on instances, which is more moving parts and more cost.

## What runs, and why Jobs (not services)

`bootstrap`, `seed:tenders`, and `fetch:documents` are one-shot, idempotent, resumable
scripts — a perfect fit for Cloud Run **Jobs** triggered by **Cloud Scheduler**. The
continuous Redis consumers are intentionally *not* used here; a daily `seed --refresh`
replaces them.

| Job | Script | Redis? | Schedule |
|---|---|---|---|
| `bootstrap` | `scripts/ingestion-bootstrap.mts` | no | once, manually |
| `seed` (bulk backfill) | `scripts/seed-tenders.mts --from 2026-01-01` | no | run until done, then delete |
| `seed-daily` (catch new) | `scripts/seed-tenders.mts --refresh 45` | no | daily |
| `fetch-documents` | `scripts/fetch-documents.mts --limit 1000` | no | daily / hourly |

`--refresh <days>` re-scans a trailing window each run: it reopens the recently-completed
month partitions so notices published since are discovered. Re-scanning never duplicates
— the writer upserts by version, so unchanged notices are no-ops. Plain `seed` cannot do
this: a `DONE` month is skipped forever and new tenders in it would be missed.

## Prerequisites

- **A real MongoDB replica set.** `bootstrap`/`seed` call `assertReplicaSet()` and need
  transactions + change streams. **Firestore's MongoDB mode almost certainly does not
  qualify** — use **Atlas M0 (free)** and point `MONGODB_URI` at its `mongodb+srv://…`
  string (Cloud Run reaches it over the public internet, no VPC connector needed).
- **GCS bucket + HMAC key** for storage — see [`README.md`](README.md) §1.
- The image lives in **Artifact Registry** (Cloud Run does not pull GHCR directly);
  [`cloudbuild.yaml`](cloudbuild.yaml) builds it there.

## 1. Enable APIs and set variables

Run everything in **Cloud Shell** (bash) to avoid PowerShell quoting.

```bash
gcloud config set project quick-elixir-458221-n0
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com secretmanager.googleapis.com

REGION=europe-west3
REPO=$REGION-docker.pkg.dev/quick-elixir-458221-n0/bauai
IMG=$REPO/tender-ingestion:latest
N="--disable-warning=MODULE_TYPELESS_PACKAGE_JSON,--experimental-strip-types"
```

## 2. Build the image to Artifact Registry

From the repo root. Re-run this whenever the ingestion code changes.

```bash
gcloud artifacts repositories create bauai --repository-format=docker --location=$REGION
gcloud builds submit --config=deploy/cloudbuild.yaml --substitutions=_IMAGE=$IMG .
```

## 3. Secrets + runtime service account

```bash
printf '%s' 'mongodb+srv://USER:PASS@your-atlas-host/?retryWrites=true&w=majority' | gcloud secrets create MONGODB_URI --data-file=-
printf '%s' 'YOUR_S3_APPLICATION_KEY' | gcloud secrets create S3_APPLICATION_KEY --data-file=-

PROJNUM=$(gcloud projects describe quick-elixir-458221-n0 --format='value(projectNumber)')
SA=$PROJNUM-compute@developer.gserviceaccount.com
for S in MONGODB_URI S3_APPLICATION_KEY; do
  gcloud secrets add-iam-policy-binding $S --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor
done
# lets Cloud Scheduler trigger the jobs
gcloud projects add-iam-policy-binding quick-elixir-458221-n0 --member="serviceAccount:$SA" --role=roles/run.developer
```

## 4. Shared env for every job

Non-secret values inline; the two secrets come from Secret Manager. Fill in your real
`S3_KEY_ID`.

```bash
ENVS="MONGODB_DB=bauai,S3_ENDPOINT=https://storage.googleapis.com,S3_REGION=auto,S3_BUCKET_NAME=bau-ai-prod,S3_KEY_ID=REPLACE_WITH_YOUR_HMAC_ACCESS_ID,S3_DOCUMENT_PREFIX=tenders/documents,S3_RAW_NOTICE_PREFIX=tenders/raw,DOCUMENTS_BIDDABLE_ONLY=true,DOCUMENTS_BROWSER_ENABLED=false"
SECRETS="MONGODB_URI=MONGODB_URI:latest,S3_APPLICATION_KEY=S3_APPLICATION_KEY:latest"
```

## 5. Create the jobs

```bash
# schema + indexes + source configs (run once)
gcloud run jobs create bootstrap --image=$IMG --region=$REGION --set-env-vars="$ENVS" --set-secrets="$SECRETS" \
  --max-retries=0 --task-timeout=900 --command=node --args="$N,scripts/ingestion-bootstrap.mts"

# bulk historical backfill (temporary — delete once complete)
gcloud run jobs create seed --image=$IMG --region=$REGION --set-env-vars="$ENVS" --set-secrets="$SECRETS" \
  --max-retries=1 --task-timeout=3600 --memory=1Gi --command=node \
  --args="$N,scripts/seed-tenders.mts,--from,2026-01-01"

# daily "catch new tenders" (permanent)
gcloud run jobs create seed-daily --image=$IMG --region=$REGION --set-env-vars="$ENVS" --set-secrets="$SECRETS" \
  --max-retries=1 --task-timeout=1800 --memory=1Gi --command=node \
  --args="$N,scripts/seed-tenders.mts,--refresh,45"

# download documents into GCS (drains a batch per run)
gcloud run jobs create fetch-documents --image=$IMG --region=$REGION --set-env-vars="$ENVS" --set-secrets="$SECRETS" \
  --max-retries=1 --task-timeout=3600 --memory=2Gi --command=node \
  --args="$N,scripts/fetch-documents.mts,--limit,1000"
```

## 6. Run the initial load, in order

```bash
gcloud run jobs execute bootstrap --region=$REGION --wait          # go/no-go on the DB (replica set)
gcloud run jobs execute seed --region=$REGION --wait               # re-run to resume if it stops early
gcloud run jobs execute fetch-documents --region=$REGION
```

Check seed progress any time (one-off execution with different args):
```bash
gcloud run jobs execute seed --region=$REGION --wait --args="$N,scripts/seed-tenders.mts,--status"
```

## 7. Schedule the ongoing jobs

```bash
NS="https://$REGION-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/quick-elixir-458221-n0/jobs"

# catch new tenders every morning
gcloud scheduler jobs create http seed-daily-cron --location=$REGION --schedule="0 5 * * *" \
  --uri="$NS/seed-daily:run" --http-method=POST --oauth-service-account-email=$SA

# fetch their documents an hour later
gcloud scheduler jobs create http fetch-daily-cron --location=$REGION --schedule="0 6 * * *" \
  --uri="$NS/fetch-documents:run" --http-method=POST --oauth-service-account-email=$SA
```

## 8. Retire the bulk seed

Once `seed` reports every partition `DONE`, delete it — `seed-daily` keeps things current:

```bash
gcloud run jobs delete seed --region=$REGION
```

## Lifecycle summary

```
bootstrap (once)
   └─ seed  ──(run until all partitions DONE, then delete)
        └─ seed-daily  --refresh 45   → daily, discovers new/updated notices
        └─ fetch-documents --limit N  → daily, downloads their files to GCS
```

## Cost & tuning

- **Cost:** Cloud Build (free tier), three scheduled jobs running a few minutes each
  (~cents/day), Atlas M0 (free), GCS = stored bytes only. No idle charges.
- **`--refresh 45`**: covers the current + previous month so late/corrected notices are
  caught. Lower to `14` for lighter runs; raise if a source publishes with more delay.
- **Documents backlog**: `--limit 1000` per run drains gradually under the 10 req/min
  per-host cap. Raise the limit or run `fetch-daily-cron` more often to catch up faster.
- **rib-meinauftrag (headless)**: leave `DOCUMENTS_BROWSER_ENABLED=false` here. To enable
  it, build [`cloudbuild.yaml`](cloudbuild.yaml) with `docker/Dockerfile.documents` and
  give the `fetch-documents` job more memory (`--memory=4Gi`).
- **Firestore reminder**: if `bootstrap` fails the replica-set check, switch `MONGODB_URI`
  to Atlas M0 — the rest of the setup is unchanged.
```
