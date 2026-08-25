from conftest import AUTH


def test_upload_rejects_traversal_names(client, session_id):
    # Plain ".." never reaches the handler (the router normalizes it away —
    # 404/405); encoded forms DO reach it and must hit the name check (400).
    # Either way: denied, and nothing is written.
    for name in ["..", "a%2Fb", ".hidden", "%2E%2E"]:
        r = client.put(
            f"/sessions/{session_id}/files/{name}",
            headers=AUTH,
            content=b"data",
        )
        assert r.status_code in (400, 404, 405), (name, r.status_code)


def test_read_rejects_escape(client, session_id):
    # Encoded traversals reach the handler as decoded rel_path and must be
    # rejected by the jail itself with 400.
    for path in ["..%2Fother%2Ffile.txt", "a%2F..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd"]:
        r = client.get(f"/sessions/{session_id}/files/{path}", headers=AUTH)
        assert r.status_code == 400, (path, r.status_code)
    # Unencoded traversals are normalized by any HTTP client/router before
    # routing — they miss the route entirely.
    for path in ["../other/file.txt", "a/../../etc/passwd"]:
        r = client.get(f"/sessions/{session_id}/files/{path}", headers=AUTH)
        assert r.status_code in (400, 404), (path, r.status_code)


def test_cross_session_isolation(client, session_id):
    client.put(f"/sessions/{session_id}/files/secret.txt", headers=AUTH, content=b"s")
    other = client.post("/sessions", headers=AUTH).json()["sessionId"]
    r = client.get(f"/sessions/{other}/files/secret.txt", headers=AUTH)
    assert r.status_code == 404


def test_bad_session_id_rejected(client):
    r = client.post("/sessions/not-a-session/exec", headers=AUTH, json={"code": "1"})
    assert r.status_code == 400


def test_exec_cannot_write_outside_workspace(client, session_id):
    r = client.post(
        f"/sessions/{session_id}/exec",
        headers=AUTH,
        json={"code": "open('/opt/toolkit/toolkit/evil.py','w').write('x')"},
    )
    body = r.json()
    assert body["exitCode"] != 0  # read-only rootfs + non-root user
