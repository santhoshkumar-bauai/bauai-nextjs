"""Targeted visual inspection.

Why this file exists: a full A4 page at 110 dpi cannot resolve the defects that
actually matter. A cover rectangle overlapping a label by 1pt destroys ~1.5px
at that scale — invisible. The same region cropped at 400 dpi makes it obvious
("Mıtglıed" vs "Mitglied").

So the critic gets two things:
  - full pages, for layout and semantics (is this value next to the right label?)
  - targeted before/after crop PAIRS at high dpi, for damage detection

The pairing is the important half. A crop of the OUTPUT alone cannot tell you a
label used to have dots on its i's. Only the diff against the SOURCE can.

Two things a crop of the LANDED region cannot answer on its own, both added
here rather than in the caller because coordinates may only originate in
extraction:

  - WHICH region. The repair loop consumes pairs[0], so the ORDER of this list
    decides what gets repaired. Issue order comes first now; the old
    fieldmap-priority sweep only tops the list up, because whenever the issues
    carried no field_id the sweep put an arbitrary valued field first and the
    model was shown one region while being asked to fix another.
  - WHERE IT BELONGS. A value on the wrong row looks perfectly correct inside
    its own crop. `targetBox` locates the field's printed label and the entry
    beside it, so the repair sees its destination as well as its mistake.
"""
from __future__ import annotations

import os
import re
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageChops

INSPECT_DPI = 400
PAD_PT = 14.0   # generous: the damage is usually just OUTSIDE the box
MAX_PAIRS = 12
# A label and the entry it introduces sit on one visual row. Wider than a row
# and the "target" stops being a target.
LABEL_ROW_PT = 16.0
MIN_LABEL_TOKEN_LEN = 3


def _crop_box(page_size: tuple[float, float], box: list[float], pad_pt: float = PAD_PT) -> list[float]:
    page_w, page_h = page_size
    x0, top, x1, bottom = box
    return [max(0.0, x0 - pad_pt), max(0.0, top - pad_pt),
            min(page_w, x1 + pad_pt), min(page_h, bottom + pad_pt)]


def _render_region(pdf_path: str, page_no: int, crop_box: list[float],
                   dpi: int = INSPECT_DPI) -> Image.Image:
    doc = pdfium.PdfDocument(pdf_path)
    page = doc[page_no - 1]
    scale = dpi / 72
    img = page.render(scale=scale).to_pil()
    x0, top, x1, bottom = crop_box
    crop = (max(0, int(x0 * scale)), max(0, int(top * scale)),
            min(img.width, int(x1 * scale)), min(img.height, int(bottom * scale)))
    return img.crop(crop)


def _stack(before: Image.Image, after: Image.Image, gap: int = 14) -> Image.Image:
    """Before over after, so the model compares two aligned strips rather than
    holding one image in memory while looking at another."""
    w = max(before.width, after.width)
    out = Image.new("RGB", (w, before.height + after.height + gap), "white")
    out.paste(before.convert("RGB"), (0, 0))
    out.paste(after.convert("RGB"), (0, before.height + gap))
    return out


def damage_score(before: Image.Image, after: Image.Image) -> float:
    """Fraction of INK REMOVED between source and output.

    Adding ink is expected — that's the fill. Removing it is not: it means a
    cover rectangle ate something. This is a cheap deterministic pre-filter that
    tells the critic which regions are worth looking at."""
    if before.size != after.size:
        after = after.resize(before.size)
    b = before.convert("L")
    a = after.convert("L")
    # pixels dark in `before` but light in `after` == ink that disappeared
    lost = ImageChops.subtract(a, b)          # positive where output is lighter
    hist = lost.histogram()
    changed = sum(hist[40:])                  # ignore antialiasing noise
    return round(changed / (b.width * b.height), 5)


def _tokens(text: str) -> list[str]:
    """Comparable words of a label. German case folding, punctuation dropped."""
    lowered = (text or "").lower().replace("ß", "ss")
    return [t for t in re.split(r"[^0-9a-zäöü]+", lowered) if len(t) >= MIN_LABEL_TOKEN_LEN]


def _intersects(a: list[float], b: list[float]) -> bool:
    return a[2] > b[0] and a[0] < b[2] and a[3] > b[1] and a[1] < b[3]


def _label_target(page_geo: dict[str, Any], page_anchors: list[dict[str, Any]],
                  field: dict[str, Any]) -> list[float] | None:
    """Where this field's value BELONGS: its printed label plus the entry beside it.

    The planner records `label` as "the nearest printed label, for the audit
    trail". That makes it the only statement of intent the pipeline keeps, and
    therefore the only way to show a repair its destination — a value snapped
    onto the wrong row sits perfectly inside a real entry box, so nothing about
    the landed region says it is wrong.

    Returns None when the label cannot be located, which is the honest answer
    for a generic label ("Datum") or a label that never made it into the text
    layer. The caller falls back to the landed region alone.
    """
    wanted = set(_tokens(field.get("label", "")))
    if not wanted:
        return None
    matched = [w for w in page_geo.get("words") or []
               if set(_tokens(w.get("text", ""))) & wanted]
    if not matched:
        return None

    # Group into visual rows and keep the row that covers the most of the label.
    rows: list[list[dict]] = []
    for word in sorted(matched, key=lambda w: (float(w["top"]), float(w["x0"]))):
        center = (float(word["top"]) + float(word["bottom"])) / 2
        for row in rows:
            first = row[0]
            if abs(((float(first["top"]) + float(first["bottom"])) / 2) - center) <= LABEL_ROW_PT:
                row.append(word)
                break
        else:
            rows.append([word])
    best = max(rows, key=lambda row: len({t for w in row for t in _tokens(w["text"])} & wanted))
    box = [
        min(float(w["x0"]) for w in best), min(float(w["top"]) for w in best),
        max(float(w["x1"]) for w in best), max(float(w["bottom"]) for w in best),
    ]

    # Extend across the entry the label introduces, so the target strip shows
    # the destination and not just the words naming it.
    row_band = [0.0, box[1] - LABEL_ROW_PT / 2, float(page_geo.get("width", 0) or 0), box[3] + LABEL_ROW_PT / 2]
    for anchor in page_anchors:
        if _intersects(anchor["box"], row_band):
            box[0] = min(box[0], float(anchor["box"][0]))
            box[2] = max(box[2], float(anchor["box"][2]))
            box[3] = max(box[3], float(anchor["box"][3]))
    return box


def _issue_regions(fieldmap: list[dict[str, Any]],
                   issues: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Fields named by the issues, in ISSUE order, de-duplicated.

    This ordering is the whole point: the repair loop repairs pairs[0].
    """
    by_id: dict[Any, dict] = {}
    for f in fieldmap:
        if f.get("id") is not None and f["id"] not in by_id:
            by_id[f["id"]] = f
    ordered: list[dict[str, Any]] = []
    for issue in issues:
        field = by_id.get(issue.get("field_id"))
        if field is None or len(field.get("box", [])) != 4:
            continue
        page = issue.get("page")
        if page is not None and int(page) != int(field.get("page", -1)):
            continue
        if any(existing is field for existing in ordered):
            continue
        ordered.append(field)
    return ordered


def _sweep_regions(fieldmap: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Broad visual sweep for the critic, which runs with no issues to go on."""
    def priority(f: dict) -> int:
        if f.get("kind") == "cover":        return 0    # destructive by nature
        if f.get("kind") == "restore_text": return 1
        return 2

    candidates = [f for f in fieldmap
                  if len(f.get("box", [])) == 4
                  and (f.get("value") or f.get("kind") == "cover")]
    candidates.sort(key=priority)
    return candidates


def inspection_pairs(source_pdf: str, output_pdf: str,
                     fieldmap: list[dict[str, Any]],
                     issues: list[dict[str, Any]],
                     out_dir: str,
                     geometry: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Pick the regions worth a close look and render before/after strips."""
    os.makedirs(out_dir, exist_ok=True)

    # Issues first (the repair reads pairs[0]), then the sweep tops the list up
    # to MAX_PAIRS so the critic still gets a broad look at a clean document.
    selected = _issue_regions(fieldmap, issues)
    for field in _sweep_regions(fieldmap):
        if len(selected) >= MAX_PAIRS:
            break
        if not any(existing is field for existing in selected):
            selected.append(field)

    codes_by_field: dict[Any, list[str]] = {}
    for issue in issues:
        if issue.get("field_id"):
            codes_by_field.setdefault(issue["field_id"], []).append(issue.get("code", "ISSUE"))

    pages_geo = {int(p["page"]): p for p in (geometry or {}).get("pages", [])}
    anchors_by_page: dict[int, list[dict[str, Any]]] = {}
    if geometry:
        from .anchors import public_anchors
        for pno in {int(f["page"]) for f in selected[:MAX_PAIRS] if f.get("page")}:
            anchors_by_page[pno] = public_anchors(geometry, {pno})

    pairs = []
    for f in selected[:MAX_PAIRS]:
        pno, box = f["page"], f["box"]
        try:
            source_doc = pdfium.PdfDocument(source_pdf)
            page = source_doc[pno - 1]
            page_size = (float(page.get_width()), float(page.get_height()))
            page_box = _crop_box(page_size, box)
            before = _render_region(source_pdf, pno, page_box)
            after = _render_region(output_pdf, pno, page_box)
        except Exception:
            continue
        if before.width < 4 or before.height < 4:
            continue
        stem = f"{f.get('id', 'x')}_p{pno}"
        before_path = os.path.join(out_dir, f"before_{stem}.png")
        after_path = os.path.join(out_dir, f"after_{stem}.png")
        comparison_path = os.path.join(out_dir, f"comparison_{stem}.png")
        before.save(before_path)
        after.save(after_path)
        _stack(before, after).save(comparison_path)

        page_anchors = anchors_by_page.get(int(pno), [])
        local_anchors = [a for a in page_anchors if _intersects(a["box"], page_box)]

        # The destination strip, rendered only when the landed region does not
        # already contain it — an in-place defect needs no second image.
        target_box = target_path = None
        target_anchors: list[dict[str, Any]] = []
        geo_page = pages_geo.get(int(pno))
        if geo_page is not None:
            located = _label_target(geo_page, page_anchors, f)
            if located is not None and not _intersects(located, box):
                target_box = _crop_box(page_size, located, pad_pt=LABEL_ROW_PT / 2)
                try:
                    t_before = _render_region(source_pdf, pno, target_box)
                    t_after = _render_region(output_pdf, pno, target_box)
                    if t_before.width >= 4 and t_before.height >= 4:
                        target_path = os.path.join(out_dir, f"target_{stem}.png")
                        _stack(t_before, t_after).save(target_path)
                        target_anchors = [a for a in page_anchors
                                          if _intersects(a["box"], target_box)]
                    else:
                        target_box = None
                except Exception:
                    target_box = target_path = None

        lost = damage_score(before, after)
        pairs.append({
            "field_id": f.get("id"),
            "page": pno,
            "kind": f.get("kind"),
            "label": f.get("label", ""),
            "issueCodes": codes_by_field.get(f.get("id"), []),
            "dpi": INSPECT_DPI,
            "cropBox": [round(v, 2) for v in page_box],
            "pixelSize": {"width": before.width, "height": before.height},
            "beforePath": before_path,
            "afterPath": after_path,
            "comparisonPath": comparison_path,
            "localAnchors": local_anchors,
            "targetBox": [round(v, 2) for v in target_box] if target_box else None,
            "targetComparisonPath": target_path,
            "targetAnchors": target_anchors,
            "measurements": {"inkLost": lost},
            # compatibility aliases for clients deployed during migration
            "path": comparison_path,
            "ink_lost": lost,
        })
    return pairs


def render_regions(pdf_path: str, regions: list[dict[str, Any]], out_dir: str,
                   dpi: int = INSPECT_DPI) -> list[dict[str, Any]]:
    """Render only explicitly requested regions; never a whole repair page."""
    os.makedirs(out_dir, exist_ok=True)
    doc = pdfium.PdfDocument(pdf_path)
    rendered = []
    for index, region in enumerate(regions):
        page_no = int(region["page"])
        page = doc[page_no - 1]
        crop_box = _crop_box((float(page.get_width()), float(page.get_height())),
                             [float(v) for v in region["box"]])
        image = _render_region(pdf_path, page_no, crop_box, dpi=dpi)
        path = os.path.join(out_dir, f"region_{index + 1}_p{page_no}.png")
        image.save(path)
        rendered.append({
            "page": page_no, "dpi": dpi,
            "cropBox": [round(v, 2) for v in crop_box],
            "pixelSize": {"width": image.width, "height": image.height},
            "path": path,
        })
    return rendered
