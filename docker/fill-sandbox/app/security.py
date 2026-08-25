"""Auth + path containment.

Two boundaries, both enforced here and nowhere else:

  1. Every request must carry the shared bearer token. The sandbox is only
     reachable from the app host (compose publishes it on 127.0.0.1 in dev,
     internal network in prod), but the token means a misconfigured publish
     doesn't become an open code-execution service.
  2. Any file path a caller supplies is resolved and must stay inside that
     caller's session workspace. The check is on the RESOLVED path, so `..`,
     absolute paths and symlink games all fail the same way.
"""
from __future__ import annotations

import os
import re

from fastapi import HTTPException, Request

WORK_ROOT = os.environ.get("FILL_SANDBOX_WORK_ROOT", "/work")

MAX_FILE_BYTES = 25 * 1024 * 1024        # per uploaded file
MAX_WORKSPACE_BYTES = 200 * 1024 * 1024  # per session workspace

_SESSION_ID = re.compile(r"^[0-9a-f]{32}$")
# uploads land at the workspace root only; reads may address subdirs the
# toolkit created (source_pages/, output_pages/, crops/)
_UPLOAD_NAME = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_READ_PATH = re.compile(r"^[A-Za-z0-9._/-]{1,256}$")


def require_token(request: Request) -> None:
    expected = os.environ.get("FILL_SANDBOX_TOKEN", "")
    got = request.headers.get("authorization", "")
    if not expected or got != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="invalid_token")


def session_dir(session_id: str, must_exist: bool = True) -> str:
    if not _SESSION_ID.fullmatch(session_id or ""):
        raise HTTPException(status_code=400, detail="bad_session_id")
    path = os.path.join(WORK_ROOT, session_id)
    if must_exist and not os.path.isdir(path):
        raise HTTPException(status_code=404, detail="session_not_found")
    return path


def safe_upload_path(session_id: str, name: str) -> str:
    if not _UPLOAD_NAME.fullmatch(name or "") or name.startswith("."):
        raise HTTPException(status_code=400, detail="bad_file_name")
    return os.path.join(session_dir(session_id), name)


def safe_read_path(session_id: str, rel_path: str) -> str:
    if not _READ_PATH.fullmatch(rel_path or "") or ".." in rel_path \
            or rel_path.startswith("/"):
        raise HTTPException(status_code=400, detail="bad_file_path")
    base = os.path.realpath(session_dir(session_id))
    resolved = os.path.realpath(os.path.join(base, rel_path))
    if resolved != base and not resolved.startswith(base + os.sep):
        raise HTTPException(status_code=400, detail="path_escape")
    if not os.path.isfile(resolved):
        raise HTTPException(status_code=404, detail="file_not_found")
    return resolved


def workspace_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return total
