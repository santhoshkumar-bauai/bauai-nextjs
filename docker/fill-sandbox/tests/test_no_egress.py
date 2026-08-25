"""Egress containment is a COMPOSE property (internal: true network), not an
app property — TestClient runs in-process and can't see it. This test only
proves anything when run inside the composed container:

    docker compose -f docker/fill-sandbox/docker-compose.yml exec fill-sandbox \
        env FILL_SANDBOX_NETWORK_TEST=1 python -m pytest /opt/tests/test_no_egress.py -q
"""
import os

import pytest

from conftest import AUTH

pytestmark = pytest.mark.skipif(
    os.environ.get("FILL_SANDBOX_NETWORK_TEST") != "1",
    reason="egress test only meaningful inside the composed container",
)


def test_exec_has_no_internet(client, session_id):
    r = client.post(
        f"/sessions/{session_id}/exec",
        headers=AUTH,
        json={
            "code": (
                "import urllib.request\n"
                "try:\n"
                "    urllib.request.urlopen('https://example.com', timeout=5)\n"
                "    print('EGRESS_OK')\n"
                "except Exception as e:\n"
                "    print('EGRESS_BLOCKED', type(e).__name__)\n"
            ),
            "timeoutMs": 20000,
        },
    )
    assert "EGRESS_BLOCKED" in r.json()["stdout"]
