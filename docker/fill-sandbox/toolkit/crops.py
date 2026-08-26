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
"""
from __future__ import annotations

import os
from typing import Any

import pypdfium2 as pdfium
from PIL import Image, ImageChops

INSPECT_DPI = 400
PAD_PT = 14.0   # generous: the damage is usually just OUTSIDE the box
MAX_PAIRS = 12


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


def inspection_pairs(source_pdf: str, output_pdf: str,
                     fieldmap: list[dict[str, Any]],
                     issues: list[dict[str, Any]],
                     out_dir: str,
                     geometry: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Pick the regions worth a close look and render before/after strips."""
    os.makedirs(out_dir, exist_ok=True)

    flagged = {i.get("field_id") for i in issues if i.get("field_id")}

    def priority(f: dict) -> int:
        if f.get("id") in flagged:      return 0    # something already complained
        if f.get("kind") == "cover":    return 1    # destructive by nature
        if f.get("kind") == "restore_text": return 2
        return 3

    candidates = [f for f in fieldmap
                  if len(f.get("box", [])) == 4
                  and (f.get("value") or f.get("kind") == "cover")]
    candidates.sort(key=priority)

    pairs = []
    for f in candidates[:MAX_PAIRS]:
        pno, box = f["page"], f["box"]
        try:
            source_doc = pdfium.PdfDocument(source_pdf)
            page = source_doc[pno - 1]
            page_box = _crop_box((float(page.get_width()), float(page.get_height())), box)
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
        local_anchors = []
        if geometry:
            from .anchors import public_anchors
            for anchor in public_anchors(geometry, {int(pno)}):
                ax0, atop, ax1, abottom = anchor["box"]
                cx0, ctop, cx1, cbottom = page_box
                if ax1 > cx0 and ax0 < cx1 and abottom > ctop and atop < cbottom:
                    local_anchors.append(anchor)
        lost = damage_score(before, after)
        pairs.append({
            "field_id": f.get("id"),
            "page": pno,
            "kind": f.get("kind"),
            "label": f.get("label", ""),
            "dpi": INSPECT_DPI,
            "cropBox": [round(v, 2) for v in page_box],
            "pixelSize": {"width": before.width, "height": before.height},
            "beforePath": before_path,
            "afterPath": after_path,
            "comparisonPath": comparison_path,
            "localAnchors": local_anchors,
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
