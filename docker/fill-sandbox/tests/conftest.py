"""Test bootstrap. These tests are meant to run INSIDE the container:

    docker compose -f docker/fill-sandbox/docker-compose.yml run --rm fill-sandbox \
        python -m pytest /opt/tests -q

(runner.py uses the POSIX `resource` module, so the suite is Linux-only.)
"""
import os
import sys

os.environ.setdefault("FILL_SANDBOX_TOKEN", "test-token")
os.environ.setdefault("FILL_SANDBOX_WORK_ROOT", "/tmp/fill-work-test")
os.makedirs(os.environ["FILL_SANDBOX_WORK_ROOT"], exist_ok=True)

sys.path.insert(0, "/opt/app")

import pytest
from fastapi.testclient import TestClient

from app.main import app

AUTH = {"Authorization": f"Bearer {os.environ['FILL_SANDBOX_TOKEN']}"}


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture()
def session_id(client: TestClient) -> str:
    r = client.post("/sessions", headers=AUTH)
    assert r.status_code == 200
    return r.json()["sessionId"]
