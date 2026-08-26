"""Free-form code execution.

This is the UNTRUSTED lane: the code arrives from an LLM. Containment layers,
outermost first — the container itself (non-root, read-only rootfs, no-egress
network, memory/cpu/pid limits from compose), then this runner (empty env,
session-dir cwd, rlimits, wall-clock kill of the whole process group, output
truncation). The trusted /run/* endpoints never pass through here.
"""
from __future__ import annotations

import os
import resource
import signal
import subprocess
import sys
import time

DEFAULT_TIMEOUT_MS = 20_000
MAX_TIMEOUT_MS = 60_000
OUTPUT_CAP_BYTES = 64 * 1024

RLIMIT_AS_BYTES = 512 * 1024 * 1024
RLIMIT_FSIZE_BYTES = 50 * 1024 * 1024
RLIMIT_NOFILE = 256
RLIMIT_NPROC = 64

TOOLKIT_PATH = os.environ.get("FILL_SANDBOX_TOOLKIT_PATH", "/opt/toolkit")


def _truncate(data: bytes) -> str:
    text = data.decode("utf-8", errors="replace")
    if len(data) <= OUTPUT_CAP_BYTES:
        return text
    return text[: OUTPUT_CAP_BYTES // 4] + "\n...[truncated]"


def _snapshot(session_path: str) -> set[str]:
    files: set[str] = set()
    for root, _dirs, names in os.walk(session_path):
        for n in names:
            files.add(os.path.relpath(os.path.join(root, n), session_path))
    return files


def run_code(session_path: str, code: str, timeout_ms: int | None) -> dict:
    timeout_ms = min(int(timeout_ms or DEFAULT_TIMEOUT_MS), MAX_TIMEOUT_MS)
    cpu_seconds = max(2, timeout_ms // 1000 + 5)

    def limits() -> None:
        resource.setrlimit(resource.RLIMIT_AS, (RLIMIT_AS_BYTES, RLIMIT_AS_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
        resource.setrlimit(resource.RLIMIT_NOFILE, (RLIMIT_NOFILE, RLIMIT_NOFILE))
        resource.setrlimit(resource.RLIMIT_FSIZE, (RLIMIT_FSIZE_BYTES, RLIMIT_FSIZE_BYTES))
        try:
            resource.setrlimit(resource.RLIMIT_NPROC, (RLIMIT_NPROC, RLIMIT_NPROC))
        except (ValueError, OSError):
            pass  # not adjustable on every kernel; pids_limit still applies

    before = _snapshot(session_path)
    started = time.monotonic()
    proc = subprocess.Popen(
        [sys.executable, "-B", "-c", code],
        cwd=session_path,
        env={
            # deliberately minimal: no inherited secrets, toolkit importable
            "PYTHONPATH": TOOLKIT_PATH,
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "HOME": session_path,
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUNBUFFERED": "1",
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
        start_new_session=True,          # so the kill reaches grandchildren
        preexec_fn=limits,
    )
    timed_out = False
    try:
        stdout, stderr = proc.communicate(timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            proc.kill()
        stdout, stderr = proc.communicate()

    return {
        "exitCode": proc.returncode,
        "timedOut": timed_out,
        "stdout": _truncate(stdout or b""),
        "stderr": _truncate(stderr or b""),
        "durationMs": int((time.monotonic() - started) * 1000),
        "newFiles": sorted(_snapshot(session_path) - before),
    }
