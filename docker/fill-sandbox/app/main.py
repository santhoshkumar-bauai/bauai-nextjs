"""Fill-sandbox exec service.

Two lanes with different trust levels:

  /sessions/{id}/exec    — UNTRUSTED. Free-form Python written by the agent,
                           contained by runner.py. Its output is observation
                           only; nothing here feeds the score.
  /sessions/{id}/run/*   — TRUSTED. Fixed toolkit code baked into the image.
                           The score the agent is graded on comes ONLY from
                           /run/validate.

Workspace file conventions (all inside /work/{sessionId}/):
  source.pdf              uploaded by the app
  geometry.json           written by /run/analyze (top-left coordinate space)
  analyze.json            classification summary written by /run/analyze
  fieldmap.json           uploaded by the app (raw values)
  fieldmap.prepared.json  written by /run/prepare (formatted + styled)
  filled.pdf              written by /run/fill
  source_pages/ output_pages/ crops/   PNG artifacts
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import runner, sessions
from .security import (
    MAX_FILE_BYTES,
    MAX_WORKSPACE_BYTES,
    require_token,
    safe_read_path,
    safe_upload_path,
    session_dir,
    workspace_bytes,
)
# absolute import: the toolkit lives on PYTHONPATH (/opt/toolkit) so the
# free-form /exec lane can `from toolkit import ...` the exact same code
from toolkit import TOOLKIT_VERSION, acroform, crops, extract, fill, formats, style, validate

app = FastAPI(title="fill-sandbox", docs_url=None, redoc_url=None)

ANALYZE_MAX_PAGES = int(os.environ.get("FILL_SANDBOX_MAX_PAGES", 15))


@app.on_event("startup")
def _start_gc() -> None:
    sessions.start_gc_thread()


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "toolkitVersion": TOOLKIT_VERSION}


# ------------------------------------------------------------------ sessions

@app.post("/sessions", dependencies=[Depends(require_token)])
def create_session() -> dict:
    return {"sessionId": sessions.create_session()}


@app.delete("/sessions/{session_id}", dependencies=[Depends(require_token)])
def delete_session(session_id: str) -> dict:
    sessions.delete_session(session_dir(session_id))
    return {"ok": True}


# --------------------------------------------------------------------- files

@app.put("/sessions/{session_id}/files/{name}", dependencies=[Depends(require_token)])
async def upload_file(session_id: str, name: str, request: Request) -> dict:
    path = safe_upload_path(session_id, name)
    body = await request.body()
    if len(body) > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="file_too_large")
    if workspace_bytes(session_dir(session_id)) + len(body) > MAX_WORKSPACE_BYTES:
        raise HTTPException(status_code=413, detail="workspace_full")
    with open(path, "wb") as fh:
        fh.write(body)
    return {
        "name": name,
        "sizeBytes": len(body),
        "sha256": hashlib.sha256(body).hexdigest(),
    }


@app.get("/sessions/{session_id}/files", dependencies=[Depends(require_token)])
def list_files(session_id: str) -> dict:
    base = session_dir(session_id)
    out = []
    for root, _dirs, names in os.walk(base):
        for n in names:
            p = os.path.join(root, n)
            out.append({
                "name": os.path.relpath(p, base).replace(os.sep, "/"),
                "sizeBytes": os.path.getsize(p),
                "mtime": os.path.getmtime(p),
            })
    return {"files": sorted(out, key=lambda f: f["name"])}


@app.get("/sessions/{session_id}/files/{rel_path:path}",
         dependencies=[Depends(require_token)])
def download_file(session_id: str, rel_path: str) -> FileResponse:
    path = safe_read_path(session_id, rel_path)
    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    return FileResponse(path, media_type=media_type)


# ---------------------------------------------------------------- exec (untrusted)

class ExecRequest(BaseModel):
    code: str
    timeoutMs: int | None = None


@app.post("/sessions/{session_id}/exec", dependencies=[Depends(require_token)])
def exec_code(session_id: str, body: ExecRequest) -> dict:
    if not body.code.strip():
        raise HTTPException(status_code=400, detail="empty_code")
    return runner.run_code(session_dir(session_id), body.code, body.timeoutMs)


# ---------------------------------------------------------------- run (trusted)

def _read_json(session_id: str, name: str):
    with open(safe_read_path(session_id, name)) as fh:
        return json.load(fh)


def _fieldmap_from(data) -> list[dict]:
    return data["fields"] if isinstance(data, dict) else data


class AnalyzeRequest(BaseModel):
    pdf: str = "source.pdf"


@app.post("/sessions/{session_id}/run/analyze", dependencies=[Depends(require_token)])
def run_analyze(session_id: str, body: AnalyzeRequest) -> dict:
    base = session_dir(session_id)
    pdf_path = safe_read_path(session_id, body.pdf)

    kind = extract.classify(pdf_path)
    result: dict = {"kind": kind}
    if kind == "scanned":
        # no geometry to extract — the caller refuses these upstream too
        with open(os.path.join(base, "analyze.json"), "w") as fh:
            json.dump(result, fh)
        return result

    geometry = extract.extract_geometry(pdf_path)
    if len(geometry["pages"]) > ANALYZE_MAX_PAGES:
        raise HTTPException(status_code=422, detail="too_many_pages")
    with open(os.path.join(base, "geometry.json"), "w") as fh:
        json.dump(geometry, fh)

    images = extract.render_pages(pdf_path, os.path.join(base, "source_pages"))
    native = acroform.describe_fields(pdf_path) if kind == "acroform" else []

    result.update({
        "pageCount": len(geometry["pages"]),
        "geometryFile": "geometry.json",
        "pageImages": [os.path.relpath(p, base).replace(os.sep, "/") for p in images],
        "nativeFields": native,
        "emptyBoxCount": sum(len(p["empty_boxes"]) for p in geometry["pages"]),
        "dottedLineCount": sum(len(p["dotted_lines"]) for p in geometry["pages"]),
    })
    with open(os.path.join(base, "analyze.json"), "w") as fh:
        json.dump({"kind": kind, "pageCount": result["pageCount"]}, fh)
    return result


class PrepareRequest(BaseModel):
    fieldmapFile: str = "fieldmap.json"


@app.post("/sessions/{session_id}/run/prepare", dependencies=[Depends(require_token)])
def run_prepare(session_id: str, body: PrepareRequest) -> dict:
    base = session_dir(session_id)
    fieldmap = _fieldmap_from(_read_json(session_id, body.fieldmapFile))
    geometry = _read_json(session_id, "geometry.json")

    # Order matters: format first (a German-formatted number is WIDER than the
    # raw one, so width checks must measure the final string), then infer type
    # size from the template, then harmonise siblings.
    prepared = formats.apply_formats(fieldmap)
    prepared = style.annotate_fieldmap(prepared, geometry)

    with open(os.path.join(base, "fieldmap.prepared.json"), "w") as fh:
        json.dump({"fields": prepared}, fh, ensure_ascii=False)
    return {
        "fieldCount": len(prepared),
        "styleGroups": len({f.get("style_group") for f in prepared
                            if f.get("style_group")}),
        "preparedFile": "fieldmap.prepared.json",
    }


class FillRequest(BaseModel):
    pdf: str = "source.pdf"
    fieldmapFile: str = "fieldmap.prepared.json"
    out: str = "filled.pdf"


def _native_values(fieldmap: list[dict]) -> dict[str, str]:
    return {f["id"]: str(f.get("value", "")) for f in fieldmap
            if f.get("target") == "acroform" and f.get("value")}


@app.post("/sessions/{session_id}/run/fill", dependencies=[Depends(require_token)])
def run_fill(session_id: str, body: FillRequest) -> dict:
    base = session_dir(session_id)
    pdf_path = safe_read_path(session_id, body.pdf)
    fieldmap = _fieldmap_from(_read_json(session_id, body.fieldmapFile))
    analyze = _read_json(session_id, "analyze.json")
    out_path = safe_upload_path(session_id, body.out)

    if analyze.get("kind") == "acroform":
        # write the REAL fields, so the output stays a valid form
        native = _native_values(fieldmap)
        acroform.fill_acroform(pdf_path, native, out_path)
        # anything an AcroForm can't express still gets stamped
        leftover = [f for f in fieldmap if f.get("target") != "acroform"]
        if leftover:
            fill.fill(out_path, leftover, out_path)
    else:
        fill.fill(pdf_path, fieldmap, out_path)

    images = extract.render_pages(out_path, os.path.join(base, "output_pages"))
    return {
        "outputFile": body.out,
        "pageImages": [os.path.relpath(p, base).replace(os.sep, "/") for p in images],
    }


class ValidateRequest(BaseModel):
    pdf: str = "filled.pdf"
    fieldmapFile: str = "fieldmap.prepared.json"


@app.post("/sessions/{session_id}/run/validate", dependencies=[Depends(require_token)])
def run_validate(session_id: str, body: ValidateRequest) -> dict:
    pdf_path = safe_read_path(session_id, body.pdf)
    fieldmap = _fieldmap_from(_read_json(session_id, body.fieldmapFile))
    geometry = _read_json(session_id, "geometry.json")
    analyze = _read_json(session_id, "analyze.json")

    overlay = [f for f in fieldmap if f.get("target") != "acroform"]
    issues = (validate.pre_checks(overlay, geometry)
              + validate.post_checks(pdf_path, overlay, geometry))
    if analyze.get("kind") == "acroform":
        issues += acroform.verify_written(pdf_path, _native_values(fieldmap))

    return {
        "issues": issues,
        "score": validate.score(issues),
        "summary": validate.summarise(issues, limit=40),
    }


class CropsRequest(BaseModel):
    sourcePdf: str = "source.pdf"
    outputPdf: str = "filled.pdf"
    fieldmapFile: str = "fieldmap.prepared.json"
    issues: list[dict] = []


@app.post("/sessions/{session_id}/run/crops", dependencies=[Depends(require_token)])
def run_crops(session_id: str, body: CropsRequest) -> dict:
    base = session_dir(session_id)
    pairs = crops.inspection_pairs(
        safe_read_path(session_id, body.sourcePdf),
        safe_read_path(session_id, body.outputPdf),
        _fieldmap_from(_read_json(session_id, body.fieldmapFile)),
        body.issues,
        os.path.join(base, "crops"),
    )
    for p in pairs:
        p["path"] = os.path.relpath(p["path"], base).replace(os.sep, "/")
    return {"pairs": pairs}
