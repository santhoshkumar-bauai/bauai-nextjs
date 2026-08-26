"""Normalisation preflight: one coordinate space for the whole pipeline.

Every stage downstream — extract, anchors, fill, validate, crops — assumes a
page whose content sits in an unrotated box anchored at (0, 0). Real documents
break that three ways, and each break is silent:

  * /Rotate 90/270: pdfplumber reports geometry in the DISPLAYED orientation
    while the overlay canvas draws in the intrinsic one — every value lands
    sideways in the margin, validation reports NOT_RENDERED across the board
    and the repair loop burns its whole budget on coordinates that were never
    the problem.
  * MediaBox not anchored at (0, 0): every drawn value shifts by the origin
    offset, and OUT_OF_BOUNDS cannot catch it because the extractor and the
    renderer disagree about where the page starts.
  * CropBox != MediaBox: the extractor measures the cropped extent (what the
    user sees), the renderer sizes its canvas from the MediaBox — the y-flip
    uses two different page heights and all text shifts vertically.

So: bake the rotation into the content stream, shift the visible (CropBox)
extent to origin, and set CropBox = MediaBox = (0, 0, w, h). Widget
annotations get the same transformation applied to their /Rect — pypdf's
content transforms leave annotations alone, and a fill on a rotated AcroForm
would otherwise write its native fields in the old space.

The rotation transform is built explicitly rather than via pypdf's
transfer_rotation_to_content: we need the SAME matrix for the annotation
rects, and the page box must be recomputed after the transfer anyway (90/270
swaps width and height).

Deterministic: a pure function of the input bytes. Documents that are already
normal are copied through byte-identical.
"""
from __future__ import annotations

import shutil

from pypdf import PdfReader, PdfWriter, Transformation
from pypdf.generic import NameObject, NumberObject, RectangleObject

# Sub-point differences are formatting noise, not geometry.
_EPS = 0.01


def _rotation(page) -> int:
    return page.rotation % 360


def _needs_work(page) -> bool:
    if _rotation(page) != 0:
        return True
    crop, media = page.cropbox, page.mediabox
    if abs(float(crop.left)) > _EPS or abs(float(crop.bottom)) > _EPS:
        return True
    return any(abs(float(crop[i]) - float(media[i])) > _EPS for i in range(4))


def needs_normalisation(pdf_path: str) -> bool:
    return any(_needs_work(p) for p in PdfReader(pdf_path).pages)


def _transform_for(rotation: int, crop: RectangleObject):
    """The content transform that bakes `rotation` and moves the visible
    extent to (0, 0), plus the resulting page size.

    Derivation for /Rotate 90 (displayed 90° clockwise): a content point
    (x, y) appears at display point (y - y0, w - x + x0) on an h-wide,
    w-tall page. 180 and 270 follow the same argument.

    The matrices are written out with EXACT 0/±1 entries rather than composed
    via Transformation().rotate(): rotate() goes through cos/sin, whose
    float results for 90° are ~6e-17 instead of 0 — enough residual skew
    that pdfminer no longer recognises a transformed `re` as an axis-aligned
    rectangle, and the extractor silently drops entry boxes.
    """
    x0, y0 = float(crop.left), float(crop.bottom)
    w, h = float(crop.width), float(crop.height)
    # (a, b, c, d, e, f): x' = a·x + c·y + e, y' = b·x + d·y + f
    if rotation == 0:
        return Transformation(ctm=(1, 0, 0, 1, -x0, -y0)), (w, h)
    if rotation == 90:
        # (x, y) → (y - y0, w - x + x0)
        return Transformation(ctm=(0, -1, 1, 0, -y0, w + x0)), (h, w)
    if rotation == 180:
        # (x, y) → (w - x + x0, h - y + y0)
        return Transformation(ctm=(-1, 0, 0, -1, w + x0, h + y0)), (w, h)
    if rotation == 270:
        # (x, y) → (h - y + y0, x - x0)
        return Transformation(ctm=(0, 1, -1, 0, h + y0, -x0)), (h, w)
    raise ValueError(f"unsupported /Rotate value {rotation}")


def _transform_annotations(page, t: Transformation) -> None:
    """Move widget /Rects through the same transform as the content. All four
    corners go through the matrix and the result is re-normalised, because a
    90/270 rotation turns a (min, max) pair into a (max, min) pair."""
    annots = page.get("/Annots")
    if not annots:
        return
    for ref in annots:
        obj = ref.get_object()
        rect = obj.get("/Rect")
        if rect is None or len(rect) != 4:
            continue
        rx0, ry0, rx1, ry1 = (float(v) for v in rect)
        corners = [(rx0, ry0), (rx1, ry0), (rx1, ry1), (rx0, ry1)]
        pts = [t.apply_on((x, y)) for x, y in corners]
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        obj[NameObject("/Rect")] = RectangleObject((min(xs), min(ys), max(xs), max(ys)))


def normalize(src_path: str, dst_path: str) -> dict:
    """Write the normalised twin of `src_path` to `dst_path`.

    Returns {"changed": bool, "pages": int}. Already-normal documents are
    copied byte-identical so the common case costs one file copy.
    """
    reader = PdfReader(src_path)
    page_count = len(reader.pages)
    if not any(_needs_work(p) for p in reader.pages):
        shutil.copyfile(src_path, dst_path)
        return {"changed": False, "pages": page_count}

    writer = PdfWriter()
    writer.append(reader)  # keeps the AcroForm tree, not just the pages
    for page in writer.pages:
        if not _needs_work(page):
            continue
        rotation = _rotation(page)
        # Snapshot the crop extent BEFORE mutating anything — both the
        # content transform and the annotation transform derive from it.
        crop = RectangleObject(
            (page.cropbox.left, page.cropbox.bottom, page.cropbox.right, page.cropbox.top)
        )
        t, (new_w, new_h) = _transform_for(rotation, crop)
        page.add_transformation(t)
        _transform_annotations(page, t)
        box = RectangleObject((0, 0, new_w, new_h))
        page.mediabox = box
        page.cropbox = box
        # Print-workflow boxes would now disagree with the page; drop them.
        for key in ("/BleedBox", "/TrimBox", "/ArtBox"):
            if key in page:
                del page[NameObject(key)]
        page[NameObject("/Rotate")] = NumberObject(0)

    with open(dst_path, "wb") as fh:
        writer.write(fh)
    return {"changed": True, "pages": page_count}
