"""Deterministic extraction. No LLM here — this is where 'pixel perfect' comes from.

Every coordinate the agent later uses is READ OUT of the PDF, never estimated
from an image. The rendered PNGs exist only so a vision model can decide what
each box MEANS, not where it is.
"""
from __future__ import annotations

import hashlib
import os
import re
from typing import Any

import pdfplumber
from pypdf import PdfReader

# "Fill here" runs printed as GLYPHS rather than drawn as lines: underscores,
# dot leaders, ellipses, dashes. German procurement forms use these constantly
# ("Firmenname: ______________________"), and treating them as ordinary text
# was hiding every entry position on such a form: the box that contains them
# looked occupied, so it never reached `empty_boxes`, and the planner was left
# with nothing to copy — which is exactly when a model starts inventing
# coordinates.
FILLER_CHARS = "_.…·-–—"
_FILLER_RE = re.compile(rf"^[{re.escape(FILLER_CHARS)}\s]+$")
MIN_FILLER_RUN = 5
PLACEHOLDER_RE = re.compile(r"^(?:-{1,3}|_{1,3}|\.{3}|…)$")
GLYPH_CONTROLS = {"❍": "radio", "○": "radio", "◯": "radio", "□": "checkbox", "☐": "checkbox"}


def is_filler(text: str) -> bool:
    """True for a run that is only leader characters — an entry line, not content."""
    stripped = (text or "").strip()
    if len(stripped) < MIN_FILLER_RUN:
        return False
    return bool(_FILLER_RE.match(stripped))


def classify_document(pdf_path: str) -> dict[str, Any]:
    """Classify the document and each page without assuming one PDF strategy.

    A file can contain native widgets on one page, digital text on another and
    an embedded scan on a third.  The legacy single `flattened` label discarded
    that distinction and made the planner apply one strategy to every page.
    """
    try:
        reader = PdfReader(pdf_path, strict=False)
        root = reader.trailer.get("/Root") or {}
        acro = root.get("/AcroForm")
        acro_obj = acro.get_object() if acro is not None else {}
        has_xfa = bool(acro_obj and acro_obj.get("/XFA"))
        native = reader.get_fields() or {}
        widget_pages: set[int] = set()
        for pno, page in enumerate(reader.pages, start=1):
            if any((a.get_object().get("/Subtype") == "/Widget") for a in (page.get("/Annots") or [])):
                widget_pages.add(pno)
    except Exception as exc:
        return {"kind": "unsupported", "pageStrategies": [], "reason": f"damaged_pdf:{type(exc).__name__}"}

    page_strategies: list[dict[str, Any]] = []
    with pdfplumber.open(pdf_path) as pdf:
        for pno, page in enumerate(pdf.pages, start=1):
            char_count = len(page.chars)
            image_count = len(page.images)
            if has_xfa:
                strategy = "xfa"
            elif pno in widget_pages:
                strategy = "acroform"
            elif char_count > 20 and image_count:
                strategy = "hybrid"
            elif char_count > 20:
                strategy = "digital"
            else:
                strategy = "scanned"
            page_strategies.append({
                "page": pno,
                "strategy": strategy,
                "charCount": char_count,
                "imageCount": image_count,
            })

    strategies = {p["strategy"] for p in page_strategies}
    if has_xfa:
        kind = "xfa"
    elif native and strategies == {"acroform"}:
        kind = "acroform"
    elif len(strategies) > 1:
        kind = "hybrid"
    elif strategies:
        kind = next(iter(strategies))
    else:
        kind = "unsupported"
    return {"kind": kind, "pageStrategies": page_strategies, "hasXfa": has_xfa}


def classify(pdf_path: str) -> str:
    """Compatibility wrapper for callers that only need the document kind."""
    return str(classify_document(pdf_path)["kind"])


def _anchor_id(page_no: int, kind: str, item: dict[str, Any]) -> str:
    raw = ":".join(str(round(float(item[k]), 2)) for k in ("x0", "top", "x1", "bottom"))
    digest = hashlib.sha1(raw.encode("ascii")).hexdigest()[:10]
    return f"p{page_no}:{kind}:{digest}"


def _is_standalone_placeholder(word: dict, words: list[dict], page_h: float) -> bool:
    text = (word.get("text") or "").strip()
    if not PLACEHOLDER_RE.fullmatch(text):
        return False
    # Page-number decorations such as "- 1 -" and inline punctuation have
    # neighbours on the same baseline.  A form answer placeholder is alone.
    cy = (float(word["top"]) + float(word["bottom"])) / 2
    same_line = [
        other for other in words
        if other is not word
        and abs(((float(other["top"]) + float(other["bottom"])) / 2) - cy) < 3.0
    ]
    if same_line:
        return False
    if float(word["top"]) < 28 or float(word["bottom"]) > page_h - 28:
        return False
    # Require a nearby label/content row above. This rejects decorative lone
    # dashes while retaining ESPD rows whose label and answer are separate.
    label_above = any(
        0 < float(word["top"]) - float(other["bottom"]) <= 34
        and not PLACEHOLDER_RE.fullmatch((other.get("text") or "").strip())
        for other in words
    )
    # Multi-page forms can break immediately before the answer row: page 25
    # of the ESPD starts with the date placeholder, then prints "Ort" below.
    # Constrain this continuation case to the top band and a nearby label below.
    continuation_at_top = float(word["top"]) < 72 and any(
        0 < float(other["top"]) - float(word["bottom"]) <= 30
        and not PLACEHOLDER_RE.fullmatch((other.get("text") or "").strip())
        for other in words
    )
    return label_above or continuation_at_top


def _row_right_boundary(word: dict, words: list[dict], page_w: float,
                        verticals: list[dict]) -> float:
    cy = (float(word["top"]) + float(word["bottom"])) / 2
    candidates = [
        float(v["x0"]) for v in verticals
        if float(v["x0"]) > float(word["x1"]) + 8
        and float(v["top"]) - 2 <= cy <= float(v["bottom"]) + 2
    ]
    if candidates:
        return min(candidates) - 2
    content_right = max((float(w["x1"]) for w in words), default=page_w - 36)
    return min(page_w - 36, max(content_right, float(word["x0"]) + 90))


def _ocr_words(pdf_path: str, page_index: int, dpi: int = 300) -> list[dict[str, Any]]:
    """Return OCR token boxes in the same point/top-left space as pdfplumber."""
    try:
        import pypdfium2 as pdfium
        import pytesseract
        from pytesseract import Output

        doc = pdfium.PdfDocument(pdf_path)
        image = doc[page_index].render(scale=dpi / 72).to_pil()
        data = pytesseract.image_to_data(image, lang="deu+eng", output_type=Output.DICT)
    except Exception:
        return []
    scale = dpi / 72
    words = []
    for i, raw in enumerate(data.get("text", [])):
        text = (raw or "").strip()
        try:
            confidence = float(data["conf"][i])
        except (TypeError, ValueError):
            confidence = -1
        if not text or confidence < 20:
            continue
        left, top = float(data["left"][i]) / scale, float(data["top"][i]) / scale
        width, height = float(data["width"][i]) / scale, float(data["height"][i]) / scale
        words.append({
            "text": text, "x0": round(left, 2), "x1": round(left + width, 2),
            "top": round(top, 2), "bottom": round(top + height, 2),
            "source": "ocr", "confidence": round(confidence / 100, 3),
        })
    return words


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
            ocr_used = False
            if len(words) < 5 and page.images:
                ocr = _ocr_words(pdf_path, pno - 1, dpi=300)
                if ocr:
                    words = ocr
                    ocr_used = True
            boxes, checkboxes, rules, verticals = [], [], [], []
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
            for line in page.lines:
                x0, x1 = float(line["x0"]), float(line["x1"])
                top, bottom = float(line["top"]), float(line["bottom"])
                if abs(x1 - x0) < 2.5 and bottom - top > 8:
                    verticals.append({"x0": round(x0, 2), "top": round(top, 2),
                                      "x1": round(x1, 2), "bottom": round(bottom, 2)})
            # Leader runs ("……", "....", "_____") are entry lines too.
            dotted = [w for w in words if is_filler(w["text"])]

            # An entry area for each leader run: the value belongs just ABOVE
            # the leader ink, so the box ends at the run's baseline and opens
            # upward. Drawn with valign "bottom" this lands the text on the
            # line the way a person filling the form by hand would.
            entry_lines = [
                {
                    "x0": w["x0"], "top": round(w["bottom"] - 12.5, 2),
                    "x1": w["x1"], "bottom": w["bottom"],
                    "w": round(w["x1"] - w["x0"], 2), "h": 12.5,
                    "derived": "leader",
                }
                for w in dotted
            ]

            # A number of official German forms use a single '-' glyph as an
            # entire answer row. Its glyph bbox is only ~4pt wide; using that
            # bbox as a text field caused the production 0.00 score. Preserve
            # the glyph bbox solely as `replace_box`, and expose the full row as
            # the trusted anchor.
            placeholder_lines = []
            for w in words:
                if not _is_standalone_placeholder(w, words, float(page.height)):
                    continue
                right = _row_right_boundary(w, words, float(page.width), verticals)
                item = {
                    "x0": w["x0"], "top": round(w["bottom"] - 12.5, 2),
                    "x1": round(right, 2), "bottom": w["bottom"],
                    "w": round(right - float(w["x0"]), 2), "h": 12.5,
                    "derived": "standalone_placeholder",
                    "replace_box": [w["x0"], w["top"], w["x1"], w["bottom"]],
                    "placeholder": w["text"],
                }
                item["anchor_id"] = _anchor_id(pno, "placeholder", item)
                placeholder_lines.append(item)

            glyph_controls = []
            for w in words:
                control_kind = GLYPH_CONTROLS.get((w.get("text") or "").strip())
                if not control_kind:
                    continue
                item = {
                    "x0": w["x0"], "top": w["top"], "x1": w["x1"], "bottom": w["bottom"],
                    "w": round(float(w["x1"]) - float(w["x0"]), 2),
                    "h": round(float(w["bottom"]) - float(w["top"]), 2),
                    "derived": "glyph", "control_kind": control_kind, "glyph": w["text"],
                }
                item["anchor_id"] = _anchor_id(pno, control_kind, item)
                glyph_controls.append(item)
            checkboxes.extend(glyph_controls)

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
                "ocr": {"used": ocr_used, "dpi": 300 if ocr_used else None,
                        "language": "deu+eng" if ocr_used else None},
                "boxes": boxes,
                "cells": cells,
                "checkboxes": checkboxes,
                "rules": rules,
                "dotted_lines": dotted,
                "entry_lines": entry_lines,
                "placeholder_lines": placeholder_lines,
                "verticals": verticals,
                "empty_boxes": _empty_boxes(boxes + cells, words),
            })
            for kind, collection in (
                ("empty_box", out["pages"][-1]["empty_boxes"]),
                ("entry_line", out["pages"][-1]["entry_lines"]),
                ("cell", out["pages"][-1]["cells"]),
                ("checkbox", out["pages"][-1]["checkboxes"]),
            ):
                for item in collection:
                    item.setdefault("anchor_id", _anchor_id(pno, kind, item))
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
    """Boxes containing no CONTENT → almost certainly an unfilled field.
    This single heuristic removes most of the work the LLM would otherwise do.

    Leader runs do not count as content: a box holding only "____________" is
    the emptiest field on the page, and treating it as occupied is what left
    underscore-lined forms with no anchors at all."""
    empty = []
    for b in boxes:
        has_text = any(
            b["x0"] - 1 <= w["x0"] and w["x1"] <= b["x1"] + 1
            and b["top"] - 1 <= w["top"] and w["bottom"] <= b["bottom"] + 1
            and not is_filler(w["text"])
            for w in words
        )
        if not has_text:
            empty.append(b)
    return empty


def render_pages(pdf_path: str, out_dir: str, dpi: int = 110,
                 pages: set[int] | None = None) -> list[str]:
    """Rasterise for the vision critic. pypdfium2 avoids a poppler dependency."""
    import pypdfium2 as pdfium

    os.makedirs(out_dir, exist_ok=True)
    paths = []
    doc = pdfium.PdfDocument(pdf_path)
    for i in range(len(doc)):
        if pages is not None and i + 1 not in pages:
            continue
        img = doc[i].render(scale=dpi / 72).to_pil()
        p = os.path.join(out_dir, f"page_{i + 1}.png")
        img.save(p)
        paths.append(p)
    return paths
