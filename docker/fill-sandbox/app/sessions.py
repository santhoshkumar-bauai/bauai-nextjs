"""Workspace lifecycle.

A workspace is a CACHE, not a store of record: the app side (S3 + Mongo) can
rebuild any session from the source PDF and the persisted fieldmap, so the GC
sweep can be aggressive without data-loss risk.
"""
from __future__ import annotations

import os
import shutil
import threading
import time
import uuid

from .security import WORK_ROOT

IDLE_TTL_SECONDS = int(os.environ.get("FILL_SANDBOX_IDLE_TTL", 2 * 60 * 60))
SWEEP_INTERVAL_SECONDS = 15 * 60


def create_session() -> str:
    session_id = uuid.uuid4().hex
    os.makedirs(os.path.join(WORK_ROOT, session_id), exist_ok=False)
    return session_id


def delete_session(path: str) -> None:
    shutil.rmtree(path, ignore_errors=True)


def _latest_mtime(path: str) -> float:
    latest = os.path.getmtime(path)
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                latest = max(latest, os.path.getmtime(os.path.join(root, f)))
            except OSError:
                pass
    return latest


def sweep_idle_workspaces() -> int:
    """Delete workspaces idle past the TTL. Returns how many were removed."""
    removed = 0
    now = time.time()
    try:
        entries = os.listdir(WORK_ROOT)
    except FileNotFoundError:
        return 0
    for name in entries:
        path = os.path.join(WORK_ROOT, name)
        if not os.path.isdir(path):
            continue
        try:
            if now - _latest_mtime(path) > IDLE_TTL_SECONDS:
                delete_session(path)
                removed += 1
        except OSError:
            continue
    return removed


def start_gc_thread() -> None:
    def loop() -> None:
        while True:
            time.sleep(SWEEP_INTERVAL_SECONDS)
            try:
                sweep_idle_workspaces()
            except Exception:
                pass  # a failed sweep must never take the service down

    threading.Thread(target=loop, daemon=True, name="workspace-gc").start()
