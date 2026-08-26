"""Deterministic checks + a numeric score.

THE key design decision in this whole system: the LLM does not decide when the
work is good enough. These functions do. An LLM asked to grade its own output
converges on "looks great to me" within two turns; a rule that says
"this glyph's x1 exceeds its box's x1 by 4.2pt" does not.

Two families of check:
  pre_checks  — run on the fieldmap BEFORE drawing (cheap, catches most bugs)
  post_checks — re-extract the PRODUCED pdf and verify reality matches intent
"""
from __future__ import annotations

from typing import Any

from reportlab.pdfbase import pdfmetrics

FONT = "Helvetica"
MIN_FONT = 6.0

# Scoring policy. Getting this wrong is the classic way to build a loop that
# never terminates: naive `1 - 0.04*n_warnings` sends a clean 14-page form to
# 0.0 purely on advisory notes, and the agent burns its whole budget chasing a
# score it can never reach.
#
#   error   -> hard gate. Any error means score 0, full stop.
#   warning -> small penalty, CAPPED, so advisory noise can't dominate.
#   info    -> reported to the planner, never scored.
WARNING_PENALTY = 0.02
WARNING_PENALTY_CAP = 0.20


def _rects_overlap(a: list[float], b: list[float], tol: float = 0.5) -> bool:
    ax0, atop, ax1, abot = a
    bx0, btop, bx1, bbot = b
    return not (ax1 - tol <= bx0 or bx1 - tol <= ax0
                or abot - tol <= btop or bbot - tol <= atop)


def _norm(s: str) -> str:
    """Casefold and drop whitespace/punctuation so comparisons survive kerning
    splits, ligature substitution and hyphenation differences."""
    return "".join(c for c in s.casefold() if c.isalnum())


def _issue(sev, code, detail, field_id=None, page=None) -> dict:
    return {"severity": sev, "code": code, "field_id": field_id,
            "page": page, "detail": detail}


# ------------------------------------------------------------- pre-draw checks

def pre_checks(fieldmap: list[dict], geometry: dict[str, Any]) -> list[dict]:
    issues: list[dict] = []
    pages = {p["page"]: p for p in geometry["pages"]}

    for f in fieldmap:
        fid, pno = f.get("id", "?"), f.get("page")
        box = f.get("box") or []
        if pno not in pages:
            issues.append(_issue("error", "BAD_PAGE", f"page {pno} not in document", fid, pno))
            continue
        pg = pages[pno]
        if len(box) != 4:
            issues.append(_issue("error", "BAD_BOX", "box must be [x0,top,x1,bottom]", fid, pno))
            continue
        x0, top, x1, bottom = box
        if x1 <= x0 or bottom <= top:
            # An anchor-backed field with a degenerate box means prepare could
            # not resolve the id it named — a stale hash, the wrong page, or a
            # kind the snapper does not handle. Saying so is the difference
            # between a fixable report and a value silently drawn at the page's
            # top-left corner behind an opaque "INVERTED_BOX [0,0,0,0]".
            if f.get("anchorId") and f.get("anchor_kind") in (None, "none"):
                issues.append(_issue("error", "UNRESOLVED_ANCHOR",
                                     f"anchorId {f['anchorId']!r} resolved to no entry "
                                     f"position on page {pno}; re-select an anchor id "
                                     f"from this page's geometry", fid, pno))
            else:
                issues.append(_issue("error", "INVERTED_BOX", f"{box}", fid, pno))
            continue
        if x0 < 0 or top < 0 or x1 > pg["width"] or bottom > pg["height"]:
            issues.append(_issue("error", "OUT_OF_BOUNDS",
                                 f"{box} outside {pg['width']}x{pg['height']}", fid, pno))

        if f.get("kind") == "text" and f.get("value"):
            size = float(f.get("font_size", 9))
            max_w = (x1 - x0) - 4
            longest = max((pdfmetrics.stringWidth(w, FONT, size)
                           for w in f["value"].split(" ")), default=0)
            if longest > max_w:
                issues.append(_issue("error", "UNWRAPPABLE_WORD",
                                     f"a single word needs {longest:.0f}pt, box gives {max_w:.0f}pt",
                                     fid, pno))
            # how far must we shrink to fit the height?
            s = size
            while _line_count(f["value"], s, max_w) * s * 1.2 > (bottom - top) - 1 and s > 1:
                s -= 0.25
            if s < MIN_FONT:
                issues.append(_issue("error", "BOX_TOO_SMALL",
                                     f"would need {s:.1f}pt (< {MIN_FONT}pt) to fit",
                                     fid, pno))
            elif s < size - 1.5:
                issues.append(_issue("warning", "HEAVY_SHRINK",
                                     f"font shrinks {size}->{s:.1f}pt", fid, pno))

        # A cover that eats template glyphs it never declared == the "Mitglied"
        # bug: bottom edge 1pt too low, clipping the dots off the i's in the
        # footnote below. Geometry catches this reliably; a pixel diff does not,
        # because a cover is SUPPOSED to remove ink. The signal is removal the
        # fieldmap never declared, so make covers state their intent:
        #     {"kind": "cover", "removes": ["17.07.2026"], ...}
        if f.get("kind") == "cover":
            declared = _norm(" ".join(f.get("removes", [])))
            restored = _norm(" ".join(r.get("value", "") for r in fieldmap
                                      if r.get("kind") == "restore_text"
                                      and r.get("page") == pno))
            for w in pg["words"]:
                wbox = [w["x0"], w["top"], w["x1"], w["bottom"]]
                if not _rects_overlap(box, wbox):
                    continue
                tok = _norm(w["text"])
                if not tok or tok in declared or tok in restored:
                    continue                       # intended, or put back
                issues.append(_issue("error", "COVER_CLIPS_TEXT",
                                     f"cover destroys undeclared template text "
                                     f"{w['text']!r} at {wbox}; add it to "
                                     f"'removes' if intended, shrink the cover, "
                                     f"or add a restore_text entry", fid, pno))

    # fields colliding with each other
    for i, a in enumerate(fieldmap):
        for b in fieldmap[i + 1:]:
            if (a.get("page") == b.get("page")
                    and a.get("kind") == "text" and b.get("kind") == "text"
                    and a.get("value") and b.get("value")
                    and len(a.get("box", [])) == 4 and len(b.get("box", [])) == 4
                    and _rects_overlap(a["box"], b["box"])):
                issues.append(_issue("error", "FIELD_OVERLAP",
                                     f"{a.get('id')} overlaps {b.get('id')}",
                                     a.get("id"), a.get("page")))

    # business rules: mutually exclusive options (vorbehaltlos vs Vorbehalte)
    groups: dict[str, list[str]] = {}
    for f in fieldmap:
        g = f.get("exclusive_group")
        if g and f.get("value"):
            groups.setdefault(g, []).append(f.get("id", "?"))
    for g, members in groups.items():
        if len(members) > 1:
            issues.append(_issue("error", "EXCLUSIVE_VIOLATION",
                                 f"group {g!r} has {members} filled; only one allowed"))

    for f in fieldmap:
        if f.get("required") and not f.get("value") and f.get("kind") == "text":
            issues.append(_issue("error", "MISSING_REQUIRED",
                                 f"{f.get('label', f.get('id'))} is required",
                                 f.get("id"), f.get("page")))

    # A value whose box matches no entry position on the page is floating —
    # the model placed it by eye. anchors.py already corrected everything it
    # could recognise, so what is left needs a human-visible answer rather
    # than silent shipping.
    for f in fieldmap:
        if f.get("kind") != "text" or not f.get("value"):
            continue
        if f.get("anchor_kind") == "none":
            issues.append(_issue("warning", "ANCHOR_MISMATCH",
                                 "box matches no entry position (empty box, table cell "
                                 "or leader line) on this page; re-derive it from the "
                                 "geometry instead of estimating from the page image",
                                 f.get("id"), f.get("page")))

    issues.extend(_label_mismatches(fieldmap, geometry))
    return issues


# ------------------------------------------------------- placement vs. label

# A printed label sits on the value's own row, or on the line directly above it.
LABEL_BAND_PT = 14.0
# Short words ("der", "und", "ja") carry no identifying signal.
MIN_LABEL_TOKEN_LEN = 4


def _tokens(text: str) -> set[str]:
    """Identifying words of a label. German folding, punctuation dropped."""
    lowered = (text or "").casefold().replace("ß", "ss")
    out, current = set(), []
    for char in lowered:
        if char.isalnum():
            current.append(char)
        elif current:
            out.add("".join(current))
            current = []
    if current:
        out.add("".join(current))
    return {t for t in out if len(t) >= MIN_LABEL_TOKEN_LEN}


def _row_index(words: list[dict]) -> dict[int, list[dict]]:
    """Words bucketed by row band — a per-field label lookup must not rescan
    a dense page's several thousand words."""
    buckets: dict[int, list[dict]] = {}
    for w in words:
        center = (float(w["top"]) + float(w["bottom"])) / 2
        buckets.setdefault(int(center // LABEL_BAND_PT), []).append(w)
    return buckets


def _label_tokens_beside(buckets: dict[int, list[dict]], box: list[float]) -> set[str]:
    """Words reading as this box's printed label: on its row and to its left,
    or on the line directly above it."""
    x0, top, x1, bottom = (float(v) for v in box)
    center = (top + bottom) / 2
    found: set[str] = set()
    lo = int((top - LABEL_BAND_PT) // LABEL_BAND_PT)
    hi = int((bottom + LABEL_BAND_PT) // LABEL_BAND_PT)
    for key in range(lo, hi + 1):
        for w in buckets.get(key, []):
            wx0, wx1 = float(w["x0"]), float(w["x1"])
            wcenter = (float(w["top"]) + float(w["bottom"])) / 2
            same_row = abs(wcenter - center) <= LABEL_BAND_PT and wx1 <= x0 + 2
            above = (0 <= top - float(w["bottom"]) <= LABEL_BAND_PT
                     and wx1 > x0 - 4 and wx0 < x1 + 4)
            if same_row or above:
                found |= _tokens(w.get("text", ""))
    return found


def _label_mismatches(fieldmap: list[dict], geometry: dict[str, Any]) -> list[dict]:
    """A value sitting beside the WRONG printed label.

    This is the one failure the rest of this module structurally cannot see.
    `snap_fieldmap` rewrites the box, `fill.py` draws that box and every check
    here measures the ink against that same box — so a whole column shifted one
    row is self-consistent and scores 1.0. The planner's recorded `label` is the
    only surviving statement of intent, so it is what we check against.

    Reported only when BOTH hold: no token of the label appears beside the
    value, AND the label does appear beside a different entry position on the
    page. One side alone is far too noisy on dense German forms — labels are
    routinely abbreviated, split across lines, or absent from the text layer.
    """
    from .anchors import public_anchors

    issues: list[dict] = []
    for page in geometry.get("pages", []):
        pno = page["page"]
        words = page.get("words") or []
        if not words:
            continue
        fields = [f for f in fieldmap
                  if f.get("page") == pno and f.get("kind") == "text"
                  and f.get("value") and f.get("label")
                  and len(f.get("box") or []) == 4]
        if not fields:
            continue

        # A label shared by several fields is a column header, not a per-row
        # label — every row would "mismatch" against the header's own row.
        seen: dict[str, int] = {}
        for f in fields:
            key = _norm(f["label"])
            seen[key] = seen.get(key, 0) + 1

        buckets = _row_index(words)
        entries = [a["box"] for a in public_anchors(geometry, {int(pno)})]
        entry_tokens = [(box, _label_tokens_beside(buckets, box)) for box in entries]

        for f in fields:
            if seen.get(_norm(f["label"]), 0) != 1:
                continue
            wanted = _tokens(f["label"])
            if not wanted:
                continue
            if wanted & _label_tokens_beside(buckets, f["box"]):
                continue
            for box, there in entry_tokens:
                if _rects_overlap(box, f["box"]) or not wanted <= there:
                    continue
                issues.append(_issue(
                    "warning", "LABEL_MISMATCH",
                    f"value sits where no part of its label {f['label']!r} is printed; "
                    f"that label is printed beside the entry at "
                    f"[{box[0]:.0f},{box[1]:.0f},{box[2]:.0f},{box[3]:.0f}] — "
                    f"re-select the anchor for THAT entry",
                    f.get("id"), pno))
                break
    return issues


def _line_count(text: str, size: float, max_w: float) -> int:
    n, cur = 1, ""
    for word in text.split(" "):
        trial = word if not cur else f"{cur} {word}"
        if pdfmetrics.stringWidth(trial, FONT, size) <= max_w:
            cur = trial
        else:
            n += 1
            cur = word
    return n


# ------------------------------------------------------------ post-draw checks

def post_checks(output_pdf: str, fieldmap: list[dict],
                source_geometry: dict[str, Any]) -> list[dict]:
    """Re-read the produced PDF and confirm reality matches intent.

    Catches everything the pre-checks can't model: font metric surprises,
    glyphs escaping their box, text landing on the wrong page."""
    from .extract import extract_geometry

    issues: list[dict] = []
    after = extract_geometry(output_pdf)
    src_pages = {p["page"]: p for p in source_geometry["pages"]}
    out_pages = {p["page"]: p for p in after["pages"]}

    for f in fieldmap:
        if f.get("kind") != "text" or not f.get("value"):
            continue
        pno = f.get("page")
        pg = out_pages.get(pno)
        if not pg:
            continue
        x0, top, x1, bottom = f["box"]

        # Gather every glyph run sitting inside the expected region and compare
        # on a normalised, space-stripped basis. Renderer kerning routinely
        # splits "Space" into "S" + "pace", so per-word matching false-alarms.
        hits = [w for w in pg["words"]
                if _rects_overlap([x0 - 3, top - 4, x1 + 3, bottom + 4],
                                  [w["x0"], w["top"], w["x1"], w["bottom"]])]
        found = _norm("".join(w["text"] for w in
                              sorted(hits, key=lambda w: (w["top"], w["x0"]))))
        want = _norm(f["value"])[:14]
        if len(want) < 3:
            continue
        if want not in found:
            issues.append(_issue("error", "NOT_RENDERED",
                                 f"expected {want!r} near {f['box']}, "
                                 f"region contains {found[:60]!r}",
                                 f.get("id"), pno))
            continue

        # Bounds are measured over the ink the fill ADDED, not over everything
        # in the region. Values are drawn ON leader lines, and pdfplumber
        # merges value glyphs with the template's dot/underscore run into one
        # "word" that ends wherever the leader artwork ends — observed as
        # every field "spanning 302-602" because the underscores run to 602.
        # A char-level diff against the source page separates our ink from the
        # template's, so leaders, labels and neighbouring pre-print can never
        # flag a correct fill. (The x-window extends 12pt past the box so a
        # genuine escape still lands in the measurement.)
        src_pg_chars = (src_pages.get(pno) or {}).get("chars") or []
        src_keys = {(c["x0"], c["top"]) for c in src_pg_chars}
        added = [c for c in (pg.get("chars") or [])
                 if _rects_overlap([x0 - 3, top - 4, x1 + 12, bottom + 4],
                                   [c["x0"], c["top"], c["x1"], c["bottom"]])
                 and (c["x0"], c["top"]) not in src_keys]
        if added:
            span_x0 = min(c["x0"] for c in added)
            span_x1 = max(c["x1"] for c in added)
            if span_x1 > x1 + 3 or span_x0 < x0 - 3:
                issues.append(_issue("error", "OVERFLOW_X",
                                     f"added text spans {span_x0:.0f}-{span_x1:.0f}, "
                                     f"box is {x0:.0f}-{x1:.0f}", f.get("id"), pno))
            if span_x1 > pg["width"] - 5:
                issues.append(_issue("error", "OFF_PAGE",
                                     "added text runs to the page edge",
                                     f.get("id"), pno))

    # Font-size parity: a value drawn noticeably smaller than the template
    # text around it reads as stamped-on. Deterministic per the house rule —
    # "if a defect can be expressed in coordinates (or point sizes), check it
    # in coordinates" — the vision critic only confirms what this can't see.
    for f in fieldmap:
        if f.get("kind") != "text" or not f.get("value"):
            continue
        pno = f.get("page")
        out_pg, src_pg = out_pages.get(pno), src_pages.get(pno)
        if not out_pg or not src_pg or len(f.get("box", [])) != 4:
            continue
        drawn = _mode_size(_chars_in_region(out_pg.get("chars") or [], f["box"], pad=1.0))
        template = _mode_size(_neighbor_chars(src_pg.get("chars") or [], f["box"]))
        if drawn and template and drawn < template - 1.5:
            issues.append(_issue("warning", "FONT_TOO_SMALL",
                                 f"value drawn at {drawn}pt but neighbouring "
                                 f"template text is {template}pt; raise font_size "
                                 f"(or widen the box so it fits)",
                                 f.get("id"), pno))

    # coverage: empty boxes in the source that nobody mapped
    mapped = {(f.get("page"), tuple(round(v) for v in f.get("box", [])))
              for f in fieldmap}
    for pno, pg in src_pages.items():
        for b in pg["empty_boxes"]:
            key = (pno, (round(b["x0"]), round(b["top"]), round(b["x1"]), round(b["bottom"])))
            if key not in mapped and not any(
                    f.get("page") == pno and len(f.get("box", [])) == 4
                    and _rects_overlap(f["box"], [b["x0"], b["top"], b["x1"], b["bottom"]])
                    for f in fieldmap):
                issues.append(_issue("info", "UNMAPPED_BOX",
                                     f"empty box at {[b['x0'], b['top'], b['x1'], b['bottom']]} "
                                     f"has no field", None, pno))
    return issues


def _chars_in_region(chars: list[dict], box: list[float], pad: float = 0.0) -> list[dict]:
    x0, top, x1, bottom = box
    return [c for c in chars
            if _rects_overlap([x0 - pad, top - pad, x1 + pad, bottom + pad],
                              [c["x0"], c["top"], c["x1"], c["bottom"]])]


def _neighbor_chars(chars: list[dict], box: list[float],
                    search_pt: float = 28.0) -> list[dict]:
    """Template glyphs on the same band as the box — usually its printed
    label. Mirrors style.suggest_style's search so check and inference agree."""
    x0, top, x1, bottom = box
    return [c for c in chars
            if (top - search_pt) <= c["top"] <= (bottom + search_pt)]


def _mode_size(chars: list[dict]) -> float | None:
    if not chars:
        return None
    counts: dict[float, int] = {}
    for c in chars:
        size = round(float(c.get("size", 0)), 1)
        if size > 0:
            counts[size] = counts.get(size, 0) + 1
    if not counts:
        return None
    return max(counts.items(), key=lambda kv: kv[1])[0]


# ------------------------------------------------------------------- scoring

def score(issues: list[dict]) -> float:
    """1.0 = clean. Errors are a hard gate; warnings cost a little, capped."""
    if any(i["severity"] == "error" for i in issues):
        return 0.0
    n_warn = sum(1 for i in issues if i["severity"] == "warning")
    penalty = min(n_warn * WARNING_PENALTY, WARNING_PENALTY_CAP)
    return round(1.0 - penalty, 4)


def summarise(issues: list[dict], limit: int = 25) -> str:
    """Compact, machine-parseable feedback for the repair prompt."""
    if not issues:
        return "No issues."
    lines = []
    for i in issues[:limit]:
        loc = f"p{i['page']}" if i.get("page") else "-"
        lines.append(f"[{i['severity'].upper()}] {i['code']} "
                     f"({loc}, field={i.get('field_id')}): {i['detail']}")
    if len(issues) > limit:
        lines.append(f"... and {len(issues) - limit} more")
    return "\n".join(lines)
