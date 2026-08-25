from conftest import AUTH


def test_requires_token(client, session_id):
    r = client.post(f"/sessions/{session_id}/exec", json={"code": "print(1)"})
    assert r.status_code == 401


def test_basic_exec_and_new_files(client, session_id):
    r = client.post(
        f"/sessions/{session_id}/exec",
        headers=AUTH,
        json={"code": "open('out.txt','w').write('hi'); print('done')"},
    )
    body = r.json()
    assert r.status_code == 200
    assert body["exitCode"] == 0
    assert body["timedOut"] is False
    assert "done" in body["stdout"]
    assert "out.txt" in body["newFiles"]


def test_toolkit_importable(client, session_id):
    r = client.post(
        f"/sessions/{session_id}/exec",
        headers=AUTH,
        json={"code": "from toolkit import formats; print(formats.de_eur(2450000))"},
    )
    body = r.json()
    assert body["exitCode"] == 0
    assert "2.450.000,00" in body["stdout"]


def test_wall_timeout_kills(client, session_id):
    r = client.post(
        f"/sessions/{session_id}/exec",
        headers=AUTH,
        json={"code": "while True: pass", "timeoutMs": 1500},
    )
    body = r.json()
    assert body["timedOut"] is True
    assert body["durationMs"] < 10_000


def test_output_truncated(client, session_id):
    r = client.post(
        f"/sessions/{session_id}/exec",
        headers=AUTH,
        json={"code": "print('x' * 200_000)"},
    )
    body = r.json()
    assert "...[truncated]" in body["stdout"]
    assert len(body["stdout"]) < 100_000


def test_env_is_minimal(client, session_id):
    r = client.post(
        f"/sessions/{session_id}/exec",
        headers=AUTH,
        json={"code": "import os; print(sorted(os.environ.keys()))"},
    )
    out = r.json()["stdout"]
    assert "FILL_SANDBOX_TOKEN" not in out
