"""Placement: values landing where they belong, and being told when they don't.

The failure these lock down is the one the rest of the validator structurally
cannot see. `snap_fieldmap` rewrites a field's box, `fill.py` draws that box,
and every geometric check measures the produced ink against that same box — so
a value snapped onto the WRONG row is entirely self-consistent and scores 1.0.
The planner's recorded `label` is the only surviving statement of intent, which
is why `LABEL_MISMATCH` checks against it.
"""
import io
import json
import os

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from toolkit import anchors, crops, extract, validate

PAGE_W, PAGE_H = A4

LABELS = ["Firmenname", "Strassenname", "Postleitzahl"]
ROW_TOP = [120.0, 150.0, 180.0]
ROW_HEIGHT = 14.0


def _labelled_form() -> bytes:
    """Three rows, each a DISTINCT printed label with its own entry box to the
    right — the shape a column shift is invisible in."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 9)
    for label, top in zip(LABELS, ROW_TOP):
        c.drawString(72, PAGE_H - (top + 11), f"{label}:")
        c.rect(200, PAGE_H - (top + ROW_HEIGHT), 200, ROW_HEIGHT, stroke=1, fill=0)
    c.save()
    return buf.getvalue()


def _write(tmp_path, data: bytes, name: str = "form.pdf") -> str:
    path = tmp_path / name
    path.write_bytes(data)
    return str(path)


def _rows(geo: dict) -> list[dict]:
    return sorted(geo["pages"][0]["empty_boxes"], key=lambda b: b["top"])


def _field(row: dict, label: str, value: str = "Wirl Ing", **extra) -> dict:
    return {"id": f"f_{label.lower()}", "page": 1, "kind": "text", "label": label,
            "box": [row["x0"], row["top"], row["x1"], row["bottom"]],
            "value": value, **extra}


def _codes(issues: list[dict]) -> set[str]:
    return {i["code"] for i in issues}


# ------------------------------------------------------------------ anchors

def test_anchor_selected_checkbox_resolves_instead_of_landing_at_the_page_corner(tmp_path):
    """public_anchors publishes checkbox anchors and the plan prompt tells the
    model to omit `box` for anchor-backed fields, so the schema's [0,0,0,0]
    default used to be drawn at the top-left corner of the page."""
    geo = extract.extract_geometry(_write(tmp_path, _checkbox_form()))
    tick = geo["pages"][0]["checkboxes"][0]
    published = {a["anchorId"] for a in anchors.public_anchors(geo)}
    assert tick["anchor_id"] in published

    field = {"id": "agree", "page": 1, "kind": "checkbox", "value": "X",
             "anchorId": tick["anchor_id"], "box": [0, 0, 0, 0], "label": "Ja"}
    snapped = anchors.snap_fieldmap([field], geo)[0]

    assert snapped["box"] != [0, 0, 0, 0]
    assert abs(snapped["box"][0] - tick["x0"]) < 0.5
    assert abs(snapped["box"][1] - tick["top"]) < 0.5


def test_an_entry_claimed_by_an_explicit_anchor_is_not_reused(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _labelled_form()))
    rows = _rows(geo)
    # One field names row 0 outright; the other is estimated close enough to
    # row 0 that the matcher would otherwise hand it the same entry.
    claimed = {"id": "named", "page": 1, "kind": "text", "label": LABELS[0],
               "anchorId": rows[0]["anchor_id"], "box": [200, 118, 400, 132],
               "value": "named value"}
    estimated = {"id": "estimated", "page": 1, "kind": "text", "label": LABELS[1],
                 "box": [200, 119, 400, 133], "value": "estimated value"}
    out = anchors.snap_fieldmap([claimed, estimated], geo)

    assert out[0]["box"][1] == rows[0]["top"]
    assert out[1]["box"][1] != rows[0]["top"], "two values snapped onto one entry"


def test_a_stale_replace_box_is_cleared_on_snap(tmp_path):
    """fill.py paints a white rectangle from replace_box. Carried over from a
    previous run it erases template ink somewhere unrelated, and
    COVER_CLIPS_TEXT never sees it — that check only inspects kind == 'cover'."""
    geo = extract.extract_geometry(_write(tmp_path, _labelled_form()))
    row = _rows(geo)[0]
    field = _field(row, LABELS[0])
    field["replace_box"] = [500, 700, 540, 712]  # nowhere near this row
    snapped = anchors.snap_fieldmap([field], geo)[0]

    assert "replace_box" not in snapped


def test_the_locked_in_snap_distance_still_snaps(tmp_path):
    """The tightened distance gate must not cost the regression it exists for:
    a value estimated one row high sits ~13pt from a 12.6pt row and must still
    be pulled onto it."""
    geo = extract.extract_geometry(_write(tmp_path, _labelled_form()))
    row = _rows(geo)[0]
    estimated = {"id": "high", "page": 1, "kind": "text", "label": LABELS[0],
                 "box": [200, row["top"] - 13.0, 400, row["bottom"] - 13.0],
                 "value": "Wirl Ing"}
    snapped = anchors.snap_fieldmap([estimated], geo)[0]
    assert snapped["anchor_kind"] != "none"
    assert abs(snapped["box"][1] - row["top"]) < 1.5


def _checkbox_form() -> bytes:
    """A drawn square, which extract.py classifies as a tick box (a "☐" glyph
    would need a font that actually has it)."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4)
    c.setFont("Helvetica", 9)
    c.drawString(72, PAGE_H - 131, "Ja")
    c.rect(92, PAGE_H - 132, 9, 9, stroke=1, fill=0)
    c.save()
    return buf.getvalue()


# ----------------------------------------------------------------- validate

def test_a_one_row_column_shift_is_reported(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _labelled_form()))
    rows = _rows(geo)
    # Every value one row too low: geometrically perfect, semantically wrong.
    shifted = [_field(rows[i + 1], LABELS[i], f"value {i}") for i in range(2)]
    issues = validate.pre_checks(anchors.snap_fieldmap(shifted, geo), geo)

    assert "LABEL_MISMATCH" in _codes(issues)
    detail = next(i for i in issues if i["code"] == "LABEL_MISMATCH")["detail"]
    assert LABELS[0] in detail, "the detail must name the label that was missed"


def test_a_correctly_placed_value_is_not_reported(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _labelled_form()))
    rows = _rows(geo)
    correct = [_field(rows[i], LABELS[i], f"value {i}") for i in range(3)]
    issues = validate.pre_checks(anchors.snap_fieldmap(correct, geo), geo)

    assert "LABEL_MISMATCH" not in _codes(issues)
    assert validate.score(issues) == 1.0


def test_a_column_header_reused_as_every_rows_label_is_not_reported(tmp_path):
    """A shared label is a table header, not a per-row label: checking it would
    flag every row but the first."""
    geo = extract.extract_geometry(_write(tmp_path, _labelled_form()))
    rows = _rows(geo)
    shared = [_field(row, "Firmenname", f"value {index}") | {"id": f"f{index}"}
              for index, row in enumerate(rows)]
    issues = validate.pre_checks(anchors.snap_fieldmap(shared, geo), geo)

    assert "LABEL_MISMATCH" not in _codes(issues)


def test_an_unresolvable_anchor_is_named_rather_than_an_inverted_box(tmp_path):
    geo = extract.extract_geometry(_write(tmp_path, _labelled_form()))
    field = {"id": "ghost", "page": 1, "kind": "text", "label": "Firmenname",
             "anchorId": "p1:empty_box:0000000000", "box": [0, 0, 0, 0],
             "value": "Wirl Ing"}
    issues = validate.pre_checks(anchors.snap_fieldmap([field], geo), geo)

    assert "UNRESOLVED_ANCHOR" in _codes(issues)
    assert "INVERTED_BOX" not in _codes(issues)


# -------------------------------------------------------------------- crops

def test_the_repaired_crop_is_the_region_the_issue_names(tmp_path):
    """The repair loop consumes pairs[0]. Ordering by fieldmap priority meant
    that whenever the issues carried no field_id — every critique finding — the
    model was handed an arbitrary valued field and asked to fix a different one.
    """
    source = _write(tmp_path, _labelled_form())
    geo = extract.extract_geometry(source)
    rows = _rows(geo)
    fieldmap = anchors.snap_fieldmap(
        [_field(rows[i], LABELS[i], f"value {i}") for i in range(3)], geo)
    out_dir = str(tmp_path / "crops")

    broken = fieldmap[2]
    issues = [{"severity": "error", "code": "OVERFLOW_X", "field_id": broken["id"],
               "page": 1, "detail": "overflow"}]
    pairs = crops.inspection_pairs(source, source, fieldmap, issues, out_dir, geo)

    assert pairs[0]["field_id"] == broken["id"]
    assert pairs[0]["issueCodes"] == ["OVERFLOW_X"]
    # The sweep still tops the list up, so the critic keeps its broad look.
    assert len(pairs) == len(fieldmap)


def test_a_misplaced_value_gets_a_strip_of_where_it_belongs(tmp_path):
    source = _write(tmp_path, _labelled_form())
    geo = extract.extract_geometry(source)
    rows = _rows(geo)
    # "Firmenname" recorded, but the value sits on the Postleitzahl row.
    misplaced = anchors.snap_fieldmap([_field(rows[2], LABELS[0])], geo)
    pairs = crops.inspection_pairs(
        source, source, misplaced,
        [{"severity": "warning", "code": "LABEL_MISMATCH", "field_id": misplaced[0]["id"],
          "page": 1, "detail": "wrong row"}],
        str(tmp_path / "crops"), geo)

    target = pairs[0]["targetBox"]
    assert target is not None, "no strip of the destination was rendered"
    assert target[1] < rows[2]["top"], "the strip must cover the Firmenname row"
    assert os.path.exists(pairs[0]["targetComparisonPath"])
    assert any(a["anchorId"] == rows[0]["anchor_id"] for a in pairs[0]["targetAnchors"])


def test_a_correctly_placed_value_needs_no_destination_strip(tmp_path):
    source = _write(tmp_path, _labelled_form())
    geo = extract.extract_geometry(source)
    rows = _rows(geo)
    placed = anchors.snap_fieldmap([_field(rows[0], LABELS[0])], geo)
    pairs = crops.inspection_pairs(
        source, source, placed,
        [{"severity": "error", "code": "OVERFLOW_X", "field_id": placed[0]["id"],
          "page": 1, "detail": "overflow"}],
        str(tmp_path / "crops"), geo)

    assert pairs[0]["targetBox"] is None
    assert pairs[0]["targetComparisonPath"] is None
