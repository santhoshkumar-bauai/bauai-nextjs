"""Deterministic extraction. No LLM here — this is where 'pixel perfect' comes from.

Every coordinate the agent later uses is READ OUT of the PDF, never estimated
from an image. The rendered PNGs exist only so a vision model can decide what
each box MEANS, not where it is.
"""
from __future__ import annotations

import os
from typing import Any

import pdfplumber
from pypdf import PdfReader


def classify(pdf_path: str) -> str:
    """acroform | flattened | scanned — decides the whole downstream strategy."""
    reader = PdfReader(pdf_path)
    if reader.get_fields():
        return "acroform"
    with pdfplumber.open(pdf_path) as pdf:
        chars = sum(len(p.chars) for p in pdf.pages)
    return "flattened" if chars > 50 else "scanned"


def extract_geometry(pdf_path: str) -> dict[str, Any]:
    """Words, boxes, checkboxes and rules with exact coordinates, per page."""
    out: dict[str, Any] = {"pages": []}
    with pdfplumber.open(pdf_path) as pdf:
        for pno, page in enumerate(pdf.pages, start=1):
            words = [
                {
                    "text": w["text"],
                    "x0": round(w["x0"], 2), "x1": round(w["x1"], 2),
                    "top": round(w["top"], 2), "bottom": round(w["bottom"], 2),
                }
                for w in page.extract_words()
            ]
            boxes, checkboxes, rules = [], [], []
            seen: set[tuple] = set()
            for r in page.rects:
                key = tuple(round(r[k], 1) for k in ("x0", "top", "x1", "bottom"))
                if key in seen:          # PDFs commonly stroke AND fill the same rect
                    continue
                seen.add(key)
                w, h = r["width"], r["height"]
                item = {
                    "x0": round(r["x0"], 2), "top": round(r["top"], 2),
                    "x1": round(r["x1"], 2), "bottom": round(r["bottom"], 2),
                    "w": round(w, 2), "h": round(h, 2),
                }
                if 5 < w < 20 and 5 < h < 20 and abs(w - h) < 5:
                    checkboxes.append(item)          # square → tick box
                elif h < 2.5 and w > 15:
                    rules.append(item)               # thin → underline / cell edge
                elif w > 25 and h > 8:
                    boxes.append(item)               # rectangle → entry box
            # dotted "………" runs are entry lines too
            dotted = [w for w in words if w["text"].count("…") > 5
                      or w["text"].count(".") > 15]

            # Many German form templates draw tables as bare horizontal rules
            # with no rectangles at all, so `boxes` comes back empty. Rebuild
            # the cells from consecutive rules before deciding what's fillable.
            cells = _cells_from_rules(rules, float(page.width))

            # char-level data is what style.py uses to match the template's
            # own type size; keep it lean (no bbox precision beyond 1dp)
            chars = [{"size": round(c["size"], 1), "fontname": c["fontname"],
                      "x0": round(c["x0"], 1), "x1": round(c["x1"], 1),
                      "top": round(c["top"], 1), "bottom": round(c["bottom"], 1)}
                     for c in page.chars]

            out["pages"].append({
                "page": pno,
                "chars": chars,
                "width": round(float(page.width), 2),
                "height": round(float(page.height), 2),
                "words": words,
                "boxes": boxes,
                "cells": cells,
                "checkboxes": checkboxes,
                "rules": rules,
                "dotted_lines": dotted,
                "empty_boxes": _empty_boxes(boxes + cells, words),
            })
    return out


def _cells_from_rules(rules: list[dict], page_w: float,
                      max_row_h: float = 60.0) -> list[dict]:
    """Pair each horizontal rule with the next one below it that shares an
    x-range, and treat the gap as a table row."""
    cells = []
    rs = sorted(rules, key=lambda r: (r["top"], r["x0"]))
    for i, a in enumerate(rs):
        for b in rs[i + 1:]:
            gap = b["top"] - a["bottom"]
            if gap <= 1:
                continue
            if gap > max_row_h:
                break
            overlap = min(a["x1"], b["x1"]) - max(a["x0"], b["x0"])
            if overlap > 0.6 * min(a["w"], b["w"]):
                cells.append({
                    "x0": max(a["x0"], b["x0"]), "top": round(a["bottom"], 2),
                    "x1": min(a["x1"], b["x1"]), "bottom": round(b["top"], 2),
                    "w": round(overlap, 2), "h": round(gap, 2),
                    "derived": "rules",
                })
                break
    return cells


def _empty_boxes(boxes: list[dict], words: list[dict]) -> list[dict]:
    """Boxes containing no glyphs → almost certainly an unfilled field.
    This single heuristic removes most of the work the LLM would otherwise do."""
    empty = []
    for b in boxes:
        has_text = any(
            b["x0"] - 1 <= w["x0"] and w["x1"] <= b["x1"] + 1
            and b["top"] - 1 <= w["top"] and w["bottom"] <= b["bottom"] + 1
            for w in words
        )
        if not has_text:
            empty.append(b)
    return empty


def render_pages(pdf_path: str, out_dir: str, dpi: int = 110) -> list[str]:
    """Rasterise for the vision critic. pypdfium2 avoids a poppler dependency."""
    import pypdfium2 as pdfium

    os.makedirs(out_dir, exist_ok=True)
    paths = []
    doc = pdfium.PdfDocument(pdf_path)
    for i in range(len(doc)):
        img = doc[i].render(scale=dpi / 72).to_pil()
        p = os.path.join(out_dir, f"page_{i + 1}.png")
        img.save(p)
        paths.append(p)
    return paths
