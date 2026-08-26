"""Entry-anchor detection and snapping.

The regression these lock down: a German form whose entry areas are printed
as underscore runs inside a rectangle. Before, the rectangle counted as
"occupied", the run was not a dotted line, and the page offered NO anchors —
so the planner estimated boxes from the page image and every value rendered
on the wrong line.
"""
import io

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from toolkit import anchors, extract

PAGE_W, PAGE_H = A4


def _underscore_form() -> bytes:
    """Entry boxes drawn as a rect + an underscore run inside, the shape that
    broke: pdfplumber sees glyphs in the box, so it looked filled."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 11)
    c.drawString(72, PAGE_H - 90, "Bieter/Bietergemeinschaft: (Bitte eintragen)")
    for i in range(3):
        top = 131.42 + i * 24.6
        c.rect(70.94, PAGE_H - (top + 12.6), 170.18, 12.6, stroke=1, fill=0)
        c.drawString(73.46, PAGE_H - (top + 11.0), "_" * 27)
    c.save()
    return buf.getvalue()


def _write(tmp_path, data: bytes) -> str:
    path = tmp_path / "form.pdf"
    path.write_bytes(data)
    return str(path)


def _standalone_hyphen_form() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 9)
    c.drawString(48, PAGE_H - 80, "Name des Wirtschaftsteilnehmers:")
    c.drawString(48, PAGE_H - 96, "-")
    c.drawString(48, PAGE_H - 125, "Straße und Hausnummer:")
    c.drawString(48, PAGE_H - 141, "---")
    # Inline punctuation and a decorated page number must not become fields.
    c.drawString(48, PAGE_H - 180, "E-Mail-Adresse - optional")
    c.drawCentredString(PAGE_W / 2, 20, "- 1 -")
    c.save()
    return buf.getvalue()


def _continued_page_form() -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 9)
    c.drawString(48, PAGE_H - 54, "-")
    c.drawString(48, PAGE_H - 74, "Ort")
    c.drawString(48, PAGE_H - 92, "-")
    c.drawString(48, PAGE_H - 112, "Unterschrift")
    c.drawCentredString(PAGE_W / 2, 20, "- 25 -")
    c.save()
    return buf.getvalue()


def test_filler_runs_are_recognised():
    assert extract.is_filler("___________________________")
    assert extract.is_filler("……………………")
    assert extract.is_filler(".....................")
    assert not extract.is_filler("Firmenname")
    assert not extract.is_filler("___")  # too short to be an entry line
    assert not extract.is_filler("Muster_Bau_GmbH")


def test_standalone_hyphens_become_full_width_stable_anchors(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _standalone_hyphen_form()))
    rows = geo["pages"][0]["placeholder_lines"]
    assert len(rows) == 2, rows
    assert all(row["w"] >= 90 for row in rows)
    assert all(row["anchor_id"].startswith("p1:placeholder:") for row in rows)
    assert all((row["replace_box"][2] - row["replace_box"][0]) < 15 for row in rows)

    # IDs and boxes are deterministic across extraction runs.
    again = extract.extract_geometry(_write(tmp_path, _standalone_hyphen_form()))
    assert [r["anchor_id"] for r in rows] == [r["anchor_id"] for r in again["pages"][0]["placeholder_lines"]]


def test_legacy_glyph_width_field_is_rebased_to_placeholder(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _standalone_hyphen_form()))
    glyph = geo["pages"][0]["placeholder_lines"][0]["replace_box"]
    legacy = [{"id": "company", "page": 1, "kind": "text", "box": glyph,
               "value": "Wirl Ing (dev)"}]
    prepared = anchors.snap_fieldmap(legacy, geo)[0]
    assert prepared["anchor_kind"] == "placeholder"
    assert prepared["box"][2] - prepared["box"][0] >= 90
    assert prepared["replace_box"] == glyph


def test_top_of_page_continuation_placeholder_is_detected(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _continued_page_form()))
    rows = geo["pages"][0]["placeholder_lines"]
    assert len(rows) == 2, rows
    assert all(row["w"] >= 90 for row in rows)


def test_underscore_boxes_become_anchors(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _underscore_form()))
    page = geo["pages"][0]
    # The rects hold only leader glyphs, so they are entry areas, not content.
    assert len(page["empty_boxes"]) == 3, page["empty_boxes"]
    # And the leader runs themselves produce ready-made entry areas.
    assert len(page["entry_lines"]) == 3
    assert len(page["dotted_lines"]) == 3


def test_estimated_box_snaps_onto_the_real_entry(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _underscore_form()))
    real = geo["pages"][0]["empty_boxes"][0]
    # What the model produced before the fix: right column, wrong line —
    # sitting above the box, straddling the row above.
    estimated = [
        {"id": "bieter_1", "page": 1, "kind": "text",
         "box": [73.46, 116, 400, 133], "value": "WIRL INGENIEURE GMBH"}
    ]
    snapped = anchors.snap_fieldmap(estimated, geo)[0]

    assert snapped["anchor_kind"] in ("empty_box", "entry_line")
    assert snapped["anchor_snapped"] is True
    assert snapped["valign"] == "bottom"
    # Vertical extent now comes from the form, not the model.
    assert abs(snapped["box"][1] - real["top"]) < 1.5
    assert abs(snapped["box"][3] - real["bottom"]) < 1.5


def test_correct_box_is_left_alone(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _underscore_form()))
    real = geo["pages"][0]["empty_boxes"][1]
    field = {"id": "ok", "page": 1, "kind": "text",
             "box": [real["x0"], real["top"], real["x1"], real["bottom"]],
             "value": "Am Kupferhammer 6b"}
    snapped = anchors.snap_fieldmap([field], geo)[0]
    assert snapped["anchor_snapped"] is False
    assert snapped["box"][1] == real["top"]


def test_far_away_box_is_reported_not_dragged(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _underscore_form()))
    field = {"id": "floating", "page": 1, "kind": "text",
             "box": [300, 600, 500, 616], "value": "nowhere near an entry"}
    snapped = anchors.snap_fieldmap([field], geo)[0]
    assert snapped["anchor_kind"] == "none"
    assert snapped["box"] == [300, 600, 500, 616]  # never silently relocated


def test_consecutive_estimated_lines_land_on_consecutive_entries(tmp_path):
    """The exact production failure: four address lines estimated by eye, each
    sitting between two real rows. They must fan out one-per-row, not pile
    onto whichever row happens to be nearest."""
    geo = extract.extract_geometry(_write(tmp_path, _underscore_form()))
    rows = sorted(geo["pages"][0]["empty_boxes"], key=lambda b: b["top"])
    estimated = [
        {"id": f"zeile_{i + 1}", "page": 1, "kind": "text",
         "box": [73.46, 116 + i * 24, 400, 133 + i * 24], "value": f"line {i + 1}"}
        for i in range(3)
    ]
    snapped = anchors.snap_fieldmap(estimated, geo)

    tops = [f["box"][1] for f in snapped]
    assert len(set(tops)) == 3, f"fields collapsed onto the same row: {tops}"
    for field, row in zip(snapped, rows):
        assert abs(field["box"][1] - row["top"]) < 1.5
        assert field["anchor_kind"] in ("empty_box", "entry_line")


def test_more_fields_than_entries_leaves_the_extra_unanchored(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _underscore_form()))
    estimated = [
        {"id": f"zeile_{i + 1}", "page": 1, "kind": "text",
         "box": [73.46, 116 + i * 24, 400, 133 + i * 24], "value": f"line {i + 1}"}
        for i in range(4)  # form only has 3 entry rows
    ]
    snapped = anchors.snap_fieldmap(estimated, geo)
    assert sum(1 for f in snapped if f.get("anchor_kind") == "none") == 1
    anchored = [f["box"][1] for f in snapped if f.get("anchor_kind") != "none"]
    assert len(set(anchored)) == 3


def test_checkboxes_and_acroform_fields_are_untouched(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _underscore_form()))
    fields = [
        {"id": "tick", "page": 1, "kind": "checkbox", "box": [80, 300, 89, 309], "value": "X"},
        {"id": "native", "page": 1, "kind": "text", "target": "acroform",
         "box": [73.46, 116, 400, 133], "value": "x"},
    ]
    out = anchors.snap_fieldmap(fields, geo)
    assert out[0]["box"] == [80, 300, 89, 309]
    assert out[1]["box"] == [73.46, 116, 400, 133]
    assert "anchor_kind" not in out[0]
