"""Normalisation preflight: rotated pages, offset MediaBoxes and
CropBox != MediaBox documents must all collapse into one coordinate space
before extraction — otherwise the extractor and the renderer disagree about
the page box and every drawn value shifts silently.

Fixture geometry mirrors test_validate's portrait form; the rotated variants
store the SAME visual form with rotated content + /Rotate, exactly like a
scanner or office export produces.
"""
import hashlib
import io
import json

from pypdf import PdfReader, PdfWriter, Transformation
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from conftest import AUTH

PAGE_W, PAGE_H = A4  # 595.27 x 841.89


def _draw_form(c: canvas.Canvas) -> None:
    c.setFont("Helvetica", 9)
    c.drawString(72, PAGE_H - 90, "Angebot für die Ausschreibung — bitte alle Felder ausfüllen.")
    c.drawString(72, PAGE_H - 114, "Firmenname:")
    c.rect(140, PAGE_H - 124, 240, 20, stroke=1, fill=0)  # top-left [140,104,380,124]
    c.drawString(72, PAGE_H - 150, "Umsatz 2025:")
    c.rect(140, PAGE_H - 160, 240, 20, stroke=1, fill=0)  # top-left [140,140,380,160]


def _plain_form() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    _draw_form(c)
    c.save()
    return buf.getvalue()


def _rotated_form() -> bytes:
    """The same form stored ROTATED: landscape MediaBox, content turned 90°
    CCW, /Rotate 90 to display upright — the classic scanner export."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(PAGE_H, PAGE_W))
    c.translate(PAGE_H, 0)
    c.rotate(90)
    _draw_form(c)
    c.save()
    reader = PdfReader(io.BytesIO(buf.getvalue()))
    writer = PdfWriter()
    writer.append(reader)
    writer.pages[0].rotate(90)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _rotated_acroform() -> bytes:
    """Rotated storage plus a native text field. The widget /Rect lives in the
    stored (rotated) space — normalisation must carry it along with the
    content or a native fill lands sideways."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(PAGE_H, PAGE_W))
    c.translate(PAGE_H, 0)
    c.rotate(90)
    _draw_form(c)
    # Portrait entry box [140,104,380,124] (top-left) == stored rect
    # x:[104,124] y:[140,380] under the CCW-90 storage transform. reportlab
    # acroform rects are NOT affected by the canvas CTM, so place it there.
    c.acroForm.textfield(
        name="company_name",
        x=104,
        y=140,
        width=20,
        height=240,
        borderWidth=0,
    )
    c.save()
    reader = PdfReader(io.BytesIO(buf.getvalue()))
    writer = PdfWriter()
    writer.append(reader)
    writer.pages[0].rotate(90)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _offset_form(dx: float = 20.0, dy: float = 30.0) -> bytes:
    """The plain form with its MediaBox anchored at (dx, dy) instead of (0,0),
    content shifted to match — visually identical, numerically shifted."""
    reader = PdfReader(io.BytesIO(_plain_form()))
    writer = PdfWriter()
    writer.append(reader)
    page = writer.pages[0]
    page.add_transformation(Transformation().translate(dx, dy))
    for box in ("mediabox", "cropbox"):
        setattr(page, box, type(page.mediabox)((dx, dy, PAGE_W + dx, PAGE_H + dy)))
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _cropped_form(margin: float = 12.0) -> bytes:
    reader = PdfReader(io.BytesIO(_plain_form()))
    writer = PdfWriter()
    writer.append(reader)
    page = writer.pages[0]
    page.cropbox = type(page.mediabox)((margin, margin, PAGE_W - margin, PAGE_H - margin))
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def _upload(client, session_id, name, data):
    r = client.put(f"/sessions/{session_id}/files/{name}", headers=AUTH, content=data)
    assert r.status_code == 200, r.text


def _analyze(client, session_id) -> dict:
    r = client.post(f"/sessions/{session_id}/run/analyze", headers=AUTH, json={})
    assert r.status_code == 200, r.text
    return r.json()


def _download(client, session_id, name) -> bytes:
    r = client.get(f"/sessions/{session_id}/files/{name}", headers=AUTH)
    assert r.status_code == 200, r.text
    return r.content


FIELDMAP = {
    "fields": [
        {
            "id": "company_name",
            "page": 1,
            "kind": "text",
            "box": [142, 106, 378, 122],
            "value": "Muster Bau GmbH",
            "value_type": "text",
            "label": "Firmenname",
        }
    ]
}


def _run_pipeline(client, session_id) -> dict:
    _upload(client, session_id, "fieldmap.json", json.dumps(FIELDMAP).encode())
    for step in ("prepare", "fill", "validate"):
        r = client.post(f"/sessions/{session_id}/run/{step}", headers=AUTH, json={})
        assert r.status_code == 200, r.text
    return r.json()


def test_already_normal_document_is_copied_byte_identical(client, session_id):
    src = _plain_form()
    _upload(client, session_id, "source.pdf", src)
    body = _analyze(client, session_id)
    assert body["normalized"] is False
    twin = _download(client, session_id, "normalized.pdf")
    assert hashlib.sha256(twin).hexdigest() == hashlib.sha256(src).hexdigest()


def test_rotated_page_yields_the_same_geometry_as_the_plain_form(client, session_id):
    """The failure this preflight exists for: pdfplumber reports geometry in
    the DISPLAYED orientation while the overlay canvas draws in the intrinsic
    one, so on a /Rotate page every value lands sideways. After baking, both
    sides read the same portrait page."""
    _upload(client, session_id, "source.pdf", _rotated_form())
    body = _analyze(client, session_id)
    assert body["normalized"] is True
    assert body["emptyBoxCount"] >= 2

    geometry = json.loads(_download(client, session_id, "geometry.json"))
    page = geometry["pages"][0]
    # 90° storage baked out: page box re-read AFTER the transfer, so the
    # swapped landscape box came back to portrait.
    assert abs(page["width"] - PAGE_W) < 1
    assert abs(page["height"] - PAGE_H) < 1
    # the entry boxes sit exactly where the plain form has them (top-left)
    boxes = sorted(page["empty_boxes"], key=lambda b: b["top"])
    assert abs(boxes[0]["x0"] - 140) < 2 and abs(boxes[0]["top"] - 104) < 2
    assert abs(boxes[1]["x0"] - 140) < 2 and abs(boxes[1]["top"] - 140) < 2


def test_rotated_page_fills_and_validates_clean(client, session_id):
    _upload(client, session_id, "source.pdf", _rotated_form())
    _analyze(client, session_id)
    result = _run_pipeline(client, session_id)
    errors = [i for i in result["issues"] if i["severity"] == "error"]
    assert errors == [], result["summary"]
    assert result["score"] >= 0.9


def test_offset_mediabox_is_anchored_and_fills_clean(client, session_id):
    """A MediaBox at (20,30) silently shifts every drawn value; after the
    preflight the same top-left fieldmap coordinates as the plain form fill
    and verify clean."""
    _upload(client, session_id, "source.pdf", _offset_form())
    body = _analyze(client, session_id)
    assert body["normalized"] is True

    twin = PdfReader(io.BytesIO(_download(client, session_id, "normalized.pdf")))
    media = twin.pages[0].mediabox
    assert float(media.left) == 0 and float(media.bottom) == 0

    result = _run_pipeline(client, session_id)
    errors = [i for i in result["issues"] if i["severity"] == "error"]
    assert errors == [], result["summary"]


def test_cropbox_becomes_the_page_box(client, session_id):
    _upload(client, session_id, "source.pdf", _cropped_form(margin=12))
    body = _analyze(client, session_id)
    assert body["normalized"] is True

    twin = PdfReader(io.BytesIO(_download(client, session_id, "normalized.pdf")))
    page = twin.pages[0]
    assert [float(v) for v in page.cropbox] == [float(v) for v in page.mediabox]
    geometry = json.loads(_download(client, session_id, "geometry.json"))
    # page box == the visible (cropped) extent
    assert abs(geometry["pages"][0]["width"] - (PAGE_W - 24)) < 1
    assert abs(geometry["pages"][0]["height"] - (PAGE_H - 24)) < 1


def test_rotated_acroform_widget_rides_the_transform(client, session_id):
    """Widget /Rects must go through the SAME matrix as the content — pypdf's
    content transforms leave annotations alone, and a native fill on a
    rotated form would otherwise land sideways."""
    _upload(client, session_id, "source.pdf", _rotated_acroform())
    body = _analyze(client, session_id)
    assert body["kind"] == "acroform"
    assert body["normalized"] is True

    fields = {f["field_id"]: f for f in body["nativeFields"]}
    assert "company_name" in fields
    box = fields["company_name"]["box"]  # top-left space on the portrait page
    assert abs(box[0] - 140) < 2 and abs(box[1] - 104) < 2
    assert abs(box[2] - 380) < 2 and abs(box[3] - 124) < 2
