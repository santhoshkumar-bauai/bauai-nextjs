"""Native AcroForm filling.

When a PDF has real form fields, stamping an overlay on top of them is the wrong
answer even though it looks identical on screen:

  - the fields stay empty, so anything that reads the form programmatically
    (a procurement portal's intake validator, for instance) sees a blank form
  - the recipient can still type into the boxes, on top of your drawn text
  - screen readers announce empty fields
  - the drawn text isn't semantically attached to anything

So: if the form is fillable, fill it. Fall back to the overlay path only for the
fields an AcroForm can't express (a signature image, a value that needs to sit
somewhere no field exists).
"""
from __future__ import annotations

from typing import Any

from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject


def _field_name(widget) -> str | None:
    """Resolve inherited /T through the widget's parent chain."""
    current = widget
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        name = current.get("/T")
        if name is not None:
            return str(name)
        parent = current.get("/Parent")
        current = parent.get_object() if parent is not None else None
    return None


def _effective(widget, key: str):
    current = widget
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if current.get(key) is not None:
            return current.get(key)
        parent = current.get("/Parent")
        current = parent.get_object() if parent is not None else None
    return None


def describe_fields(pdf_path: str) -> list[dict[str, Any]]:
    """Enumerate the real fields, with the metadata the planner needs.

    Note the widget rect is [x0, y_bottom, x1, y_top] in PDF's bottom-left
    origin — the OPPOSITE of everything else in this codebase. Convert once,
    here, so the planner only ever sees top-left coordinates."""
    reader = PdfReader(pdf_path)
    raw = reader.get_fields() or {}
    out: list[dict[str, Any]] = []

    # widget annotations carry the geometry; the field dict carries the semantics
    widgets: dict[str, tuple[int, list[float]]] = {}
    for pno, page in enumerate(reader.pages, start=1):
        page_h = float(page.mediabox.height)
        for annot in page.get("/Annots") or []:
            obj = annot.get_object()
            if obj.get("/Subtype") != "/Widget":
                continue
            name = _field_name(obj)
            if name is None:
                continue
            r = [float(v) for v in obj.get("/Rect", [0, 0, 0, 0])]
            widgets[str(name)] = (pno, [r[0], page_h - r[3], r[2], page_h - r[1]])

    for name, f in raw.items():
        ftype = f.get("/FT")
        kind = {"/Tx": "text", "/Btn": "button",
                "/Ch": "choice", "/Sig": "signature"}.get(str(ftype), "unknown")
        entry: dict[str, Any] = {
            "field_id": str(name),
            "kind": kind,
            "label": str(f.get("/TU") or ""),      # tooltip = human label
            "current": str(f.get("/V") or ""),
            "readonly": bool(int(f.get("/Ff", 0)) & 1),
        }
        pno, box = widgets.get(str(name), (None, None))
        entry["page"], entry["box"] = pno, box

        if kind == "button":
            states = _button_states(raw, name)
            entry["on_value"] = next((s for s in states if s != "/Off"), "/Yes")
            entry["off_value"] = "/Off"
        elif kind == "choice":
            entry["options"] = [str(o) for o in (f.get("/_States_") or [])]
        out.append(entry)
    return out


def _button_states(raw: dict, name: str) -> list[str]:
    f = raw[name]
    states = f.get("/_States_")
    if states:
        return [str(s) for s in states]
    return ["/Yes", "/Off"]


def fill_acroform(source_pdf: str, values: dict[str, str], output_pdf: str,
                  flatten: bool = False) -> str:
    """Write values into the real fields.

    NeedAppearances tells the viewer to generate the visual appearance itself.
    Without it, many viewers render the field as blank even though the value is
    stored — a failure mode that is invisible in a text dump and obvious to the
    person you sent the form to."""
    reader = PdfReader(source_pdf)
    writer = PdfWriter()
    writer.append(reader)

    writer.set_need_appearances_writer(True)
    for page in writer.pages:
        present = {}
        for annot in page.get("/Annots") or []:
            obj = annot.get_object()
            name = _field_name(obj)
            if name is not None and str(name) in values:
                present[str(name)] = values[str(name)]
        if present:
            writer.update_page_form_field_values(page, present)

    if flatten:                      # make it non-editable before submission
        _flatten(writer)

    with open(output_pdf, "wb") as fh:
        writer.write(fh)
    return output_pdf


def _flatten(writer: PdfWriter) -> None:
    """Strip field interactivity, keeping the rendered appearance."""
    for page in writer.pages:
        for annot in page.get("/Annots") or []:
            obj = annot.get_object()
            obj[NameObject("/Ff")] = obj.get("/Ff", 0).__class__(1)  # read-only
    root = writer._root_object
    if "/AcroForm" in root:
        root["/AcroForm"][NameObject("/NeedAppearances")] = \
            root["/AcroForm"].get("/NeedAppearances", False).__class__(True)


def verify_written(output_pdf: str, values: dict[str, str]) -> list[dict]:
    """Read the values straight back out. Same principle as post_checks:
    confirm reality matches intent rather than trusting the write succeeded."""
    reader = PdfReader(output_pdf, strict=False)
    got = reader.get_fields() or {}
    issues = []
    for k, want in values.items():
        have = str(got.get(k, {}).get("/V", "")) if k in got else None
        if have is None:
            issues.append({"severity": "error", "code": "FIELD_MISSING",
                           "field_id": k, "page": None,
                           "detail": f"field {k!r} not present in output"})
        elif want and want not in have:
            issues.append({"severity": "error", "code": "VALUE_NOT_WRITTEN",
                           "field_id": k, "page": None,
                           "detail": f"wrote {want!r}, read back {have!r}"})
    issues.extend(verify_integrity(reader, values))
    return issues


def verify_integrity(reader: PdfReader, expected: dict[str, str] | None = None) -> list[dict]:
    """Validate canonical fields, widgets, inherited values and appearances."""
    expected = expected or {}
    issues: list[dict] = []
    seen_widgets: set[tuple[str, int, tuple[float, ...]]] = set()
    widget_names: set[str] = set()
    root = reader.trailer.get("/Root") or {}
    acro_ref = root.get("/AcroForm")
    acro = acro_ref.get_object() if acro_ref is not None else {}
    need_appearances = bool(acro.get("/NeedAppearances")) if acro else False

    for pno, page in enumerate(reader.pages, start=1):
        for annot in page.get("/Annots") or []:
            widget = annot.get_object()
            if widget.get("/Subtype") != "/Widget":
                continue
            name = _field_name(widget)
            if not name:
                issues.append({"severity": "error", "code": "ORPHAN_WIDGET",
                               "field_id": None, "page": pno,
                               "detail": "widget has no canonical or inherited field name"})
                continue
            widget_names.add(name)
            rect = tuple(round(float(v), 2) for v in widget.get("/Rect", []))
            key = (name, pno, rect)
            if key in seen_widgets:
                issues.append({"severity": "warning", "code": "DUPLICATE_WIDGET",
                               "field_id": name, "page": pno,
                               "detail": "duplicate widget with identical page and rectangle"})
            seen_widgets.add(key)

            value = str(_effective(widget, "/V") or "")
            if expected.get(name) and expected[name] not in value:
                issues.append({"severity": "error", "code": "WIDGET_VALUE_MISMATCH",
                               "field_id": name, "page": pno,
                               "detail": f"widget effective value is {value!r}"})
            # /AP can live on the widget; NeedAppearances is an allowed viewer
            # fallback, but at least one of them must exist for visible output.
            if expected.get(name) and not widget.get("/AP") and not need_appearances:
                issues.append({"severity": "error", "code": "APPEARANCE_MISSING",
                               "field_id": name, "page": pno,
                               "detail": "filled widget has no appearance stream"})

    for name in (reader.get_fields() or {}):
        if name not in widget_names:
            issues.append({"severity": "warning", "code": "ORPHAN_FIELD",
                           "field_id": name, "page": None,
                           "detail": "canonical field has no page widget"})
    return issues
