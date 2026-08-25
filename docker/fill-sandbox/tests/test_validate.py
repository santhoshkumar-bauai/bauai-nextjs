"""Golden-path test of the whole trusted lane: build a small German-style form
with reportlab, run analyze -> prepare -> fill -> validate through the HTTP
surface, and pin the scoring behaviour (clean map scores high, an unwrappable
word is a hard 0.0)."""
import io

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from conftest import AUTH

PAGE_W, PAGE_H = A4  # 595.27 x 841.89


def _sample_form() -> bytes:
    """One labeled entry box + enough template text to classify as 'flattened'."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 9)
    c.drawString(72, PAGE_H - 90, "Angebot für die Ausschreibung — bitte alle Felder ausfüllen.")
    c.drawString(72, PAGE_H - 114, "Firmenname:")
    # entry box: top-left space [140, 104, 380, 124]
    c.rect(140, PAGE_H - 124, 240, 20, stroke=1, fill=0)
    c.drawString(72, PAGE_H - 150, "Umsatz 2025:")
    # entry box: top-left space [140, 140, 380, 160]
    c.rect(140, PAGE_H - 160, 240, 20, stroke=1, fill=0)
    c.save()
    return buf.getvalue()


def _upload(client, session_id, name, data):
    r = client.put(f"/sessions/{session_id}/files/{name}", headers=AUTH, content=data)
    assert r.status_code == 200, r.text


def _fieldmap(value: str) -> dict:
    return {
        "fields": [
            {
                "id": "company_name",
                "page": 1,
                "kind": "text",
                "box": [142, 106, 378, 122],
                "value": value,
                "value_type": "text",
                "label": "Firmenname",
            },
            {
                "id": "revenue_2025",
                "page": 1,
                "kind": "text",
                "box": [142, 142, 378, 158],
                "value": "2450000",
                "value_type": "eur",
                "label": "Umsatz 2025",
            },
        ]
    }


def _run_pipeline(client, session_id, fieldmap: dict) -> dict:
    import json

    _upload(client, session_id, "fieldmap.json", json.dumps(fieldmap).encode())
    r = client.post(f"/sessions/{session_id}/run/prepare", headers=AUTH, json={})
    assert r.status_code == 200, r.text
    r = client.post(f"/sessions/{session_id}/run/fill", headers=AUTH, json={})
    assert r.status_code == 200, r.text
    r = client.post(f"/sessions/{session_id}/run/validate", headers=AUTH, json={})
    assert r.status_code == 200, r.text
    return r.json()


def test_analyze_classifies_flattened(client, session_id):
    _upload(client, session_id, "source.pdf", _sample_form())
    r = client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})
    body = r.json()
    assert body["kind"] == "flattened"
    assert body["pageCount"] == 1
    assert body["pageImages"] == ["source_pages/page_1.png"]
    assert body["emptyBoxCount"] >= 2


def test_clean_fieldmap_scores_high_and_formats_german(client, session_id):
    _upload(client, session_id, "source.pdf", _sample_form())
    client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})

    result = _run_pipeline(client, session_id, _fieldmap("Muster Bau GmbH"))
    errors = [i for i in result["issues"] if i["severity"] == "error"]
    assert errors == [], result["summary"]
    assert result["score"] >= 0.9

    # the deterministic formatter, not the model, produced the German rendering
    import json

    prepared = json.loads(
        client.get(
            f"/sessions/{session_id}/files/fieldmap.prepared.json", headers=AUTH
        ).content
    )
    by_id = {f["id"]: f for f in prepared["fields"]}
    assert by_id["revenue_2025"]["value"] == "2.450.000,00"


def test_undersized_font_is_flagged(client, session_id):
    _upload(client, session_id, "source.pdf", _sample_form())
    client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})

    fieldmap = _fieldmap("Muster Bau GmbH")
    for field in fieldmap["fields"]:
        field["font_size"] = 6  # template text is 9pt — visibly stamped-on
    result = _run_pipeline(client, session_id, fieldmap)
    codes = {i["code"] for i in result["issues"]}
    assert "FONT_TOO_SMALL" in codes, result["summary"]
    # advisory, not a hard failure: warnings only dent the score
    assert result["score"] > 0.9


def test_unwrappable_word_is_hard_zero(client, session_id):
    _upload(client, session_id, "source.pdf", _sample_form())
    client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})

    result = _run_pipeline(
        client, session_id, _fieldmap("Donaudampfschifffahrtsgesellschaftskapitaenswitwenrentenauszahlungsstelle")
    )
    codes = {i["code"] for i in result["issues"]}
    assert "UNWRAPPABLE_WORD" in codes
    assert result["score"] == 0.0
