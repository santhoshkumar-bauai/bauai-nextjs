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


def _render_region(pdf_path: str, page_no: int, box: list[float],
                   dpi: int = INSPECT_DPI) -> Image.Image:
    doc = pdfium.PdfDocument(pdf_path)
    page = doc[page_no - 1]
    scale = dpi / 72
    img = page.render(scale=scale).to_pil()
    x0, top, x1, bottom = box
    crop = (max(0, int((x0 - PAD_PT) * scale)),
            max(0, int((top - PAD_PT) * scale)),
            min(img.width, int((x1 + PAD_PT) * scale)),
            min(img.height, int((bottom + PAD_PT) * scale)))
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
                     out_dir: str) -> list[dict[str, Any]]:
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
            before = _render_region(source_pdf, pno, box)
            after = _render_region(output_pdf, pno, box)
        except Exception:
            continue
        if before.width < 4 or before.height < 4:
            continue
        path = os.path.join(out_dir, f"pair_{f.get('id', 'x')}_p{pno}.png")
        _stack(before, after).save(path)
        pairs.append({
            "field_id": f.get("id"),
            "page": pno,
            "kind": f.get("kind"),
            "label": f.get("label", ""),
            "path": path,
            "ink_lost": damage_score(before, after),
        })
    return pairs
