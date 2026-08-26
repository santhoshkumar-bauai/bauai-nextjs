"""fieldmap + source.pdf -> filled.pdf

Pure function. No LLM, no randomness. Given the same fieldmap you get a
byte-comparable PDF every time, which is what makes the loop debuggable and
what lets you drop the LLM entirely once a template is onboarded.
"""
from __future__ import annotations

import io
from typing import Any

from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

FONT = "Helvetica"
BASELINE_RATIO = 0.79   # top-of-box -> baseline, calibrated against Arial metrics


def wrap(text: str, size: float, max_w: float) -> list[str]:
    lines, cur = [], ""
    for word in text.split(" "):
        trial = word if not cur else f"{cur} {word}"
        if pdfmetrics.stringWidth(trial, FONT, size) <= max_w:
            cur = trial
        else:
            if cur:
                lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines


def _draw_text(c, f: dict[str, Any], page_h: float) -> None:
    x0, top, x1, bottom = f["box"]
    pad = 2.0
    size = float(f.get("font_size", 9))
    align = f.get("align", "left")
    valign = f.get("valign", "middle")
    max_w = (x1 - x0) - 2 * pad

    lines = wrap(f["value"], size, max_w)
    # shrink-to-fit rather than overflow; validate.py flags if it shrinks too far
    while len(lines) * size * 1.2 > (bottom - top) - 1 and size > 5:
        size -= 0.25
        lines = wrap(f["value"], size, max_w)

    lh = size * 1.2
    block_h = len(lines) * lh
    if valign == "top":
        y_top = top + pad
    elif valign == "bottom":
        y_top = bottom - block_h - 0.5
    else:
        y_top = top + ((bottom - top) - block_h) / 2

    c.setFont(FONT, size)
    for i, line in enumerate(lines):
        y = page_h - (y_top + i * lh + size * BASELINE_RATIO)   # the y-flip
        if align == "center":
            c.drawCentredString((x0 + x1) / 2, y, line)
        elif align == "right":
            c.drawRightString(x1 - pad, y, line)
        else:
            c.drawString(x0 + pad, y, line)


def build_overlay(fields: list[dict], page_w: float, page_h: float):
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(page_w, page_h))
    drew = False

    # order matters: covers first, then restores, then values on top
    order = {"cover": 0, "restore_rule": 1, "restore_text": 1,
             "checkbox": 2, "text": 2}
    for f in sorted(fields, key=lambda f: order.get(f["kind"], 3)):
        kind = f["kind"]
        # Placeholder-backed text fields cover exactly the original '-' glyph,
        # never the full row and never the nearby label.
        if kind == "text" and len(f.get("replace_box", [])) == 4:
            rx0, rtop, rx1, rbottom = f["replace_box"]
            c.setFillColorRGB(1, 1, 1)
            c.rect(rx0 - .5, page_h - (rbottom + .5), (rx1 - rx0) + 1,
                   (rbottom - rtop) + 1, stroke=0, fill=1)
            c.setFillColorRGB(0, 0, 0)
        if kind == "cover":
            x0, top, x1, bottom = f["box"]
            c.setFillColorRGB(1, 1, 1)
            c.rect(x0, page_h - bottom, x1 - x0, bottom - top, stroke=0, fill=1)
            c.setFillColorRGB(0, 0, 0)
        elif kind == "restore_rule":
            x0, top, x1, bottom = f["box"]
            c.rect(x0, page_h - bottom, x1 - x0, bottom - top, stroke=0, fill=1)
        elif kind == "restore_text":
            x0, top, _, _ = f["box"]
            size = float(f.get("font_size", 9))
            c.setFont(FONT, size)
            c.drawString(x0, page_h - (top + size * BASELINE_RATIO), f["value"])
        elif kind == "checkbox":
            x0, top, x1, bottom = f["box"]
            size = min(bottom - top, 9)
            c.setFont(FONT, size)
            c.drawCentredString((x0 + x1) / 2,
                                page_h - (top + (bottom - top) * 0.8),
                                f.get("value") or "X")
        elif kind == "text":
            if not f.get("value"):
                continue
            _draw_text(c, f, page_h)
        drew = True

    c.save()
    buf.seek(0)
    return PdfReader(buf).pages[0] if drew else None


def fill(source_pdf: str, fieldmap: list[dict], output_pdf: str) -> str:
    reader = PdfReader(source_pdf)
    writer = PdfWriter()
    for i, page in enumerate(reader.pages, start=1):
        page_fields = [f for f in fieldmap if f.get("page") == i]
        if page_fields:
            ov = build_overlay(page_fields,
                               float(page.mediabox.width),
                               float(page.mediabox.height))
            if ov is not None:
                page.merge_page(ov)
        writer.add_page(page)
    with open(output_pdf, "wb") as fh:
        writer.write(fh)
    return output_pdf
