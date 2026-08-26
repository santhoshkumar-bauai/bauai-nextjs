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
    """One labeled entry box + enough template text to classify as digital."""
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


def test_analyze_classifies_digital(client, session_id):
    _upload(client, session_id, "source.pdf", _sample_form())
    r = client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})
    body = r.json()
    assert body["kind"] == "digital"
    assert body["pageCount"] == 1
    assert body["pageImages"] == ["source_pages/page_1.png"]
    assert body["emptyBoxCount"] >= 2


def _espd_hyphen_fixture() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    for page in range(1, 26):
        c.setFont("Helvetica", 9)
        c.drawString(48, PAGE_H - 50, f"ESPD request — page {page}")
        if page in (1, 2, 25):
            c.drawString(48, PAGE_H - 90, "Name / Ort / Erklärung:")
            c.drawString(48, PAGE_H - 106, "-")
            c.drawString(48, PAGE_H - 136, "Kontakt / Datum:")
            c.drawString(48, PAGE_H - 152, "---")
            c.drawString(48, PAGE_H - 180, "Inline - punctuation is not a field")
        c.drawCentredString(PAGE_W / 2, 20, f"- {page} -")
        c.showPage()
    c.save()
    return buf.getvalue()


def test_espd_pages_rebase_hyphens_without_zero_width(client, session_id):
    import json

    _upload(client, session_id, "source.pdf", _espd_hyphen_fixture())
    analyze = client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={}).json()
    assert analyze["pageCount"] == 25
    assert analyze["placeholderCount"] == 6
    assert analyze["anchorCount"] >= 6

    geometry = json.loads(client.get(
        f"/sessions/{session_id}/files/geometry.json", headers=AUTH
    ).content)
    fields = []
    for page in (1, 2, 25):
        for index, row in enumerate(geometry["pages"][page - 1]["placeholder_lines"]):
            fields.append({
                "id": f"value_p{page}_{index}", "page": page, "kind": "text",
                # production legacy shape: the four-point placeholder glyph
                "box": row["replace_box"], "value": f"Grounded value {page}-{index}",
                "label": "ESPD value",
            })
    _upload(client, session_id, "fieldmap.json", json.dumps({"fields": fields}).encode())
    prepared_response = client.post(f"/sessions/{session_id}/run/prepare", headers=AUTH, json={})
    assert prepared_response.status_code == 200, prepared_response.text
    prepared = json.loads(client.get(
        f"/sessions/{session_id}/files/fieldmap.prepared.json", headers=AUTH
    ).content)["fields"]
    assert all(field["box"][2] - field["box"][0] >= 90 for field in prepared)
    assert all(field["anchor_kind"] == "placeholder" for field in prepared)
    assert all("replace_box" in field for field in prepared)


def test_batch_and_region_endpoints_are_scoped(client, session_id):
    import json

    _upload(client, session_id, "source.pdf", _espd_hyphen_fixture())
    client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})
    geometry = json.loads(client.get(
        f"/sessions/{session_id}/files/geometry.json", headers=AUTH
    ).content)
    row = geometry["pages"][0]["placeholder_lines"][0]
    field = {"id": "company", "page": 1, "kind": "text", "box": row["replace_box"],
             "value": "Wirl Ing (dev)", "label": "Name"}
    _upload(client, session_id, "fieldmap.json", json.dumps({"fields": [field]}).encode())
    client.post(f"/sessions/{session_id}/run/prepare", headers=AUTH, json={})

    fill_response = client.post(
        f"/sessions/{session_id}/run/fill-batch", headers=AUTH,
        json={"pageStart": 1, "pageEnd": 4},
    )
    assert fill_response.status_code == 200, fill_response.text
    assert fill_response.json()["pageImages"] == [f"batch_pages/page_{page}.png" for page in range(1, 5)]
    invalid = client.post(
        f"/sessions/{session_id}/run/fill-batch", headers=AUTH,
        json={"pageStart": 1, "pageEnd": 5},
    )
    assert invalid.status_code == 422

    region = client.post(
        f"/sessions/{session_id}/run/render-regions", headers=AUTH,
        json={"pdf": "batch_1_4.pdf", "dpi": 400, "regions": [{"page": 1, "box": row["replace_box"]}]},
    ).json()["regions"][0]
    assert region["dpi"] == 400
    assert region["pixelSize"]["width"] > 0
    assert region["cropBox"][2] > region["cropBox"][0]


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


def test_value_on_leader_line_is_not_flagged_as_overflow(client, session_id):
    """German forms print 'Firmenname: ______________' with the leader running
    far past where the value ends. The drawn value interleaves with the
    underscores, pdfplumber merges them into one giant 'word' ending at the
    leader's end, and the naive bounds check read that as OVERFLOW_X/OFF_PAGE
    on a perfectly correct fill. Bounds must measure only the ADDED ink."""
    import io
    import json

    from reportlab.pdfgen import canvas as rl_canvas

    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 9)
    c.drawString(72, PAGE_H - 90, "Angebot für die Ausschreibung — bitte alle Felder ausfüllen.")
    c.drawString(72, PAGE_H - 114, "Firmenname:")
    # leader line from x=150 nearly to the page edge (top-left row ~104-124)
    c.drawString(150, PAGE_H - 121, "_" * 80)
    c.save()
    _upload(client, session_id, "source.pdf", buf.getvalue())
    client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})

    fieldmap = {
        "fields": [
            {
                "id": "company_name",
                "page": 1,
                "kind": "text",
                "box": [152, 106, 380, 122],
                "value": "Muster Bau GmbH",
                "value_type": "text",
                "label": "Firmenname",
            }
        ]
    }
    result = _run_pipeline(client, session_id, fieldmap)
    codes = {i["code"] for i in result["issues"]}
    assert "OVERFLOW_X" not in codes, result["summary"]
    assert "OFF_PAGE" not in codes, result["summary"]
    assert "NOT_RENDERED" not in codes, result["summary"]
    assert result["score"] >= 0.9


def test_unwrappable_word_is_hard_zero(client, session_id):
    _upload(client, session_id, "source.pdf", _sample_form())
    client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})

    result = _run_pipeline(
        client, session_id, _fieldmap("Donaudampfschifffahrtsgesellschaftskapitaenswitwenrentenauszahlungsstelle")
    )
    codes = {i["code"] for i in result["issues"]}
    assert "UNWRAPPABLE_WORD" in codes
    assert result["score"] == 0.0
