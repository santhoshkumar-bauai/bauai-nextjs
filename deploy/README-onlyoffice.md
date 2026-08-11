# ONLYOFFICE Document Filler deployment

## Release gates

1. Complete the ONLYOFFICE Community Edition AGPL/additional-terms and trademark review. The custom image adds a separate plugin and must retain upstream notices and clearly identify the modification.
2. Use a dedicated host with at least 4 GB free memory, 40 GB free disk, swap, and persistent volumes. Production baseline: GCE `e2-standard-4`, persistent data disk, no spot scheduling.
3. Create two independent 32+ byte secrets: `OO_JWT_SECRET` for Document Server and `OO_AI_JWT_SECRET` for Clara plugin grants.
4. Configure TLS and WebSocket forwarding for `NEXT_PUBLIC_DS_URL`. Document Server must reach `INTERNAL_APP_URL`; web and conversion worker must reach `DS_INTERNAL_URL`; Document Server must reach the private S3 presigned URLs.

## Deploy Document Server

From `deploy/`, with `OO_JWT_SECRET` present in the environment:

```sh
docker compose -f docker-compose.onlyoffice.yml build --pull
docker compose -f docker-compose.onlyoffice.yml up -d
docker compose -f docker-compose.onlyoffice.yml ps
curl -fsS https://docs.example.com/healthcheck
```

The image is pinned to `onlyoffice/documentserver:9.4.0` and installs the Clara plugin without replacing core editor files. Dokploy must attach the service to the external `dokploy-network` and route the public hostname to container port 80.

## Deploy BAU AI

- Pass `NEXT_PUBLIC_DS_URL` as a web-image build argument.
- Provide every ONLYOFFICE variable from `.env.example` to the web runtime and conversion worker.
- Start `workers/onlyoffice.mts` as exactly one always-on worker. It consumes conversion jobs and reconciles interrupted save commits once per minute.
- Start with `ONLYOFFICE_ENABLED=true` and `ONLYOFFICE_AI_ENABLED=false`. Enable AI only after editor/save acceptance passes.

## Acceptance and operations

- Verify upload, edit, close, callback persistence, reopen, tender working-copy isolation, DOC/XLS conversion, version restore, two-user co-editing, force-save without a key change, and cross-company `404`s.
- Then enable Clara and verify Word revisions are attributed to Clara and Excel/PDF proposals require explicit selection.
- Load test 25 simultaneous editors with callbacks and AI operations before production approval.
- Snapshot the three persistent Document Server volumes and database metadata; S3 version objects are the authoritative recoverable document history. Rehearse restoration before launch.
- Alert on `/healthcheck`, callback 5xx rate, conversion failures, orphan-version count, CPU/memory/disk, and WebSocket disconnects.
- Apply an object-storage lifecycle rule to remove stale `workspace-documents/*/pending/*` objects after 24 hours. Committed `versions/` objects must not expire.
- Upgrade quarterly only after running the golden DOCX/XLSX/PDF round-trip corpus against the candidate pinned version.
