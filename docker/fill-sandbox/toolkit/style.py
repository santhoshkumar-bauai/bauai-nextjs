"""Make filled values look like they belong to the document.

A value set in a different size or weight to the label beside it looks stamped
on — which is exactly the tell a procurement officer notices.

Two things this does:

1. Infer size from the template text AROUND the field, not from a constant.
2. Map the template's embedded font to a metrically compatible base font.
   You cannot reuse an embedded SUBSET font (`SJTQTO+ArialMT` contains only the
   glyphs the template happened to use — your value will hit a missing glyph and
   render blank or as a box). But Helvetica and Arial share metrics to within a
   rounding error, so substituting is safe and invisible.
"""
from __future__ import annotations

import re
from typing import Any

# base-14 substitutes that are metrically compatible with common embedded fonts
FONT_MAP = {
    "arial":            "Helvetica",
    "arialmt":          "Helvetica",
    "arial-boldmt":     "Helvetica-Bold",
    "arial-italicmt":   "Helvetica-Oblique",
    "arial-bolditalicmt": "Helvetica-BoldOblique",
    "helvetica":        "Helvetica",
    "calibri":          "Helvetica",        # not metric-identical, close enough
    "timesnewromanpsmt": "Times-Roman",
    "timesnewromanps-boldmt": "Times-Bold",
    "times":            "Times-Roman",
    "couriernew":       "Courier",
}

DEFAULT_FONT = "Helvetica"
DEFAULT_SIZE = 9.0


def _strip_subset(fontname: str) -> str:
    """`SJTQTO+ArialMT` -> `arialmt`. The six-letter prefix is a subset tag."""
    name = re.sub(r"^[A-Z]{6}\+", "", fontname or "")
    return name.lower()


def base_font_for(fontname: str) -> str:
    return FONT_MAP.get(_strip_subset(fontname), DEFAULT_FONT)


def suggest_style(box: list[float], page_geo: dict[str, Any],
                  search_pt: float = 28.0) -> dict[str, Any]:
    """Look at the template text nearest this box and copy its size/font.

    Prefers text on the same baseline band (a label to the left of the field),
    then falls back to the line above, then to the page's dominant body size."""
    x0, top, x1, bottom = box
    chars = page_geo.get("chars") or []
    if not chars:
        return {"font_size": DEFAULT_SIZE, "font": DEFAULT_FONT, "source": "default"}

    def band(c):
        return (top - search_pt) <= c["top"] <= (bottom + search_pt)

    # 1. same row, to the left — almost always the field's own label
    same_row = [c for c in chars
                if band(c) and c["x1"] <= x0 + 2
                and abs(((c["top"] + c["bottom"]) / 2) - ((top + bottom) / 2)) < 12]
    # 2. anything vertically near the box
    nearby = [c for c in chars if band(c)]

    for pool, src in ((same_row, "row_label"), (nearby, "nearby")):
        if pool:
            size = _mode([round(c["size"], 1) for c in pool])
            font = _mode([c["fontname"] for c in pool])
            return {"font_size": _clamp(size, bottom - top),
                    "font": base_font_for(font), "source": src}

    size = _mode([round(c["size"], 1) for c in chars])
    return {"font_size": _clamp(size, bottom - top),
            "font": DEFAULT_FONT, "source": "page_body"}


def _clamp(size: float, box_h: float) -> float:
    """Never exceed what the box can physically hold.

    Padding is 2.5pt, not 4: line-derived boxes are only ~12pt tall, and the
    old clamp forced 8pt into a 9pt-label form — the filled value visibly
    smaller than the template text next to it, which is exactly the stamped-on
    look style inference exists to avoid."""
    return round(max(6.0, min(size, max(6.0, box_h - 2.5))), 1)


def _mode(values: list) -> Any:
    counts: dict[Any, int] = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    return max(counts.items(), key=lambda kv: kv[1])[0]


def harmonise(fieldmap: list[dict], group_key: str = "style_group") -> list[dict]:
    """Give every field in a group the largest size that fits ALL of them.

    Without this, shrink-to-fit operates per field: four boxes in one table end
    up at 11pt, 11pt, 8.5pt and 9.75pt because one value happened to be long.
    That looks worse than setting all four at 8.5pt, which is what a person
    filling the form by hand would do. Group siblings explicitly:

        {"id": "profil_1", "style_group": "firmenprofil", ...}
    """
    from reportlab.pdfbase import pdfmetrics

    groups: dict[str, list[dict]] = {}
    for f in fieldmap:
        g = f.get(group_key)
        if g and f.get("kind") == "text" and f.get("value"):
            groups.setdefault(g, []).append(f)

    for g, members in groups.items():
        size = min(float(m.get("font_size", DEFAULT_SIZE)) for m in members)
        while size > 6.0:
            if all(_fits(m, size, pdfmetrics) for m in members):
                break
            size -= 0.25
        for m in members:
            m["font_size"] = round(size, 2)
            m["style_group_size"] = True
    return fieldmap


def _fits(f: dict, size: float, pdfmetrics) -> bool:
    x0, top, x1, bottom = f["box"]
    max_w = (x1 - x0) - 4
    font = f.get("font", DEFAULT_FONT)
    lines, cur = 1, ""
    for word in f["value"].split(" "):
        trial = word if not cur else f"{cur} {word}"
        if pdfmetrics.stringWidth(trial, font, size) <= max_w:
            cur = trial
        else:
            lines += 1
            cur = word
        if pdfmetrics.stringWidth(cur, font, size) > max_w:
            return False                      # single word too wide
    return lines * size * 1.2 <= (bottom - top) - 1


def annotate_fieldmap(fieldmap: list[dict], geometry: dict) -> list[dict]:
    """Fill in font/font_size for any field that didn't specify them.

    Run this AFTER planning: it means the planner doesn't have to guess type
    sizes, which it is bad at, and the values come from the document instead."""
    pages = {p["page"]: p for p in geometry["pages"]}
    out = []
    for f in fieldmap:
        f = dict(f)
        if f.get("kind") in ("text",) and f.get("page") in pages:
            if not f.get("font_size") or not f.get("font"):
                st = suggest_style(f["box"], pages[f["page"]])
                f.setdefault("font", st["font"])
                f.setdefault("font_size", st["font_size"])
                f["style_source"] = st["source"]
        out.append(f)
    return harmonise(out)
