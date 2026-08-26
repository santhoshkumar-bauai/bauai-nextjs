# fill-sandbox

Python execution sidecar for the chat-based PDF form-filling agent
(`lib/ai/fill-agent/`). Ported from the `pdf-form-agent` POC.

## Trust model

Two lanes, different trust:

| Lane | Trust | What runs |
|---|---|---|
| `POST /sessions/{id}/exec` | **untrusted** — free-form Python written by the LLM | contained by `runner.py`: session-dir cwd, empty env, rlimits (AS 512MB / CPU / NOFILE / FSIZE), wall-clock kill, 64KB output caps |
| `POST /sessions/{id}/run/*` | **trusted** — fixed toolkit code baked into the image | `toolkit/`: extract / prepare / fill / validate / crops. The score the agent is graded on comes **only** from `/run/validate` |

Container-level containment (compose): `internal: true` network (zero
internet egress for executed code), read-only rootfs, tmpfs `/tmp`, non-root
uid 10001, `mem_limit 1g`, `cpus 1.0`, `pids_limit 256`. The `socat` gateway
is the only bridge to the host, published on `127.0.0.1:8971`.

## Dev quickstart (Windows Docker Desktop)

```bash
npm run sandbox:fill
```

then check `http://127.0.0.1:8971/healthz`. Auth for every other endpoint:
`Authorization: Bearer $FILL_SANDBOX_TOKEN` (dev default
`dev-fill-sandbox-token`, matching `.env.example`).

## Tests

```bash
docker compose -f docker/fill-sandbox/docker-compose.yml run --rm fill-sandbox python -m pytest /opt/tests -q
```

The egress test only proves anything inside the composed network:

```bash
docker compose -f docker/fill-sandbox/docker-compose.yml exec -e FILL_SANDBOX_NETWORK_TEST=1 fill-sandbox python -m pytest /opt/tests/test_no_egress.py -q
```

## Workspace conventions

`/work/{sessionId}/`: `source.pdf` (uploaded), `geometry.json` + `analyze.json`
(written by `/run/analyze`), `fieldmap.json` (uploaded, raw values),
`fieldmap.prepared.json` (written by `/run/prepare` — formatted + styled),
`filled.pdf` (written by `/run/fill`), `source_pages/` `output_pages/`
`crops/` (PNG artifacts).

Workspaces are a cache: S3 + Mongo hold the truth and the app re-hydrates a
missing workspace on demand (`ensureSandbox()` in `lib/ai/fill-agent/context.ts`).
Idle workspaces are swept after 2h.

All coordinates in this container are **PDF points, top-left origin**
`[x0, top, x1, bottom]` (pdfplumber convention). The Node side never converts
or produces coordinates — they live and die here.

## Production (Coolify/Dokploy)

Drop the `gateway` service, attach `fill-sandbox` to the shared internal
network (like `docker/onlyoffice/`), set a real `FILL_SANDBOX_TOKEN`, and
point `FILL_SANDBOX_URL` at the internal DNS name. Hardening beyond POC grade
(per-exec uid, seccomp, gVisor) slots in behind the same API.
