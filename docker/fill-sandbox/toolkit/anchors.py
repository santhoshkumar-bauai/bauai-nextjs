"""Snap planned field boxes onto real entry positions.

The system prompt tells the planner to copy every coordinate out of the
geometry. Prompts cannot enforce that, and the failure is silent: a box a few
points off renders text floating between two lines, or straddling the rule
below it, and no width/overflow check notices — they all measure the box the
model asserted, not the box the FORM actually has.

So the assertion is checked here, in code. Every text field is matched against
the page's real entry positions (empty boxes, table cells, leader-line entry
areas); the winner's vertical extent replaces the model's, and the horizontal
range is clamped into it. A field that matches nothing keeps its box and is
marked `anchor_kind: "none"` so validate.py can charge for it and the repair
loop can see it.

Vertical extent is taken from the anchor because that is what the model gets
wrong (which line the value belongs on). Horizontal is kept because the model
is genuinely useful there: choosing the column inside a wide table row.
"""
from __future__ import annotations

from typing import Any

# A value may sit at most this far from the entry it claims before we treat it
# as a different row entirely and refuse to snap. Roughly one table row.
MAX_CENTER_SHIFT_PT = 26.0
# Ignore candidates that barely share the field's x-range: a value in column 3
# must not snap onto column 1's cell just because they share a row.
MIN_X_OVERLAP_RATIO = 0.25
# Below this the snap is noise, not a correction, and stays unreported.
SNAP_EPSILON_PT = 0.75
MIN_SNAPPED_WIDTH_PT = 12.0

_SNAPPABLE_KINDS = ("text",)


def _overlaps(a: dict, b: dict) -> bool:
    return not (
        float(a["x1"]) <= float(b["x0"]) or float(b["x1"]) <= float(a["x0"])
        or float(a["bottom"]) <= float(b["top"]) or float(b["bottom"]) <= float(a["top"])
    )


def _candidates(page: dict[str, Any]) -> list[tuple[dict, str]]:
    """Every DISTINCT entry position on the page, most specific first.

    One visual row is usually described twice — the rectangle around it and
    the leader run inside it. Keeping both would let two different values
    snap onto the same row from opposite descriptions, so the coarser
    duplicate is dropped and each row is offered exactly once.
    """
    placeholders = [(p, "placeholder") for p in page.get("placeholder_lines") or []]
    boxes = [(b, "empty_box") for b in page.get("empty_boxes") or []]
    kept: list[tuple[dict, str]] = list(placeholders) + list(boxes)
    for line in page.get("entry_lines") or []:
        if not any(_overlaps(line, box) for box, _ in boxes):
            kept.append((line, "entry_line"))
    for cell in page.get("cells") or []:
        if not any(_overlaps(cell, existing) for existing, _ in kept):
            kept.append((cell, "cell"))
    return kept


def public_anchors(geometry: dict[str, Any], pages: set[int] | None = None) -> list[dict[str, Any]]:
    """Wire-safe anchor inventory. Coordinates originate only in extraction."""
    result: list[dict[str, Any]] = []
    for page in geometry.get("pages", []):
        if pages is not None and int(page["page"]) not in pages:
            continue
        for item, kind in _candidates(page):
            result.append({
                "anchorId": item.get("anchor_id"), "page": page["page"], "kind": kind,
                "box": [item["x0"], item["top"], item["x1"], item["bottom"]],
                **({"replaceBox": item["replace_box"]} if item.get("replace_box") else {}),
            })
        for item in page.get("checkboxes") or []:
            result.append({
                "anchorId": item.get("anchor_id"), "page": page["page"],
                "kind": item.get("control_kind") or "checkbox",
                "box": [item["x0"], item["top"], item["x1"], item["bottom"]],
            })
    return result


def snap_fieldmap(
    fieldmap: list[dict[str, Any]], geometry: dict[str, Any]
) -> list[dict[str, Any]]:
    """Return the fieldmap with text boxes snapped onto real entry positions.

    Assignment is one-to-one AND order-preserving, solved per page: values read
    top-to-bottom must land on entries top-to-bottom. Picking the best pair
    first instead would slide a whole column by one row whenever the estimates
    are uniformly offset — each value overlaps the row above its own more than
    its own — and four address lines end up one row too high, together.
    """
    pages = {p["page"]: p for p in geometry.get("pages", [])}
    fields = [dict(f) for f in fieldmap]

    by_page: dict[Any, list[int]] = {}
    snappable: list[int] = []
    for index, field in enumerate(fields):
        box = field.get("box") or []
        page_no = field.get("page")
        if (
            field.get("kind") not in _SNAPPABLE_KINDS
            or field.get("target") == "acroform"  # native fields carry their own rect
            or len(box) != 4
            or page_no not in pages
        ):
            continue
        snappable.append(index)
        by_page.setdefault(page_no, []).append(index)

    assigned: dict[int, tuple[dict, str]] = {}
    for page_no, indices in by_page.items():
        candidates = _candidates(pages[page_no])
        by_id = {item.get("anchor_id"): (item, kind) for item, kind in candidates}
        # New fieldmaps select a stable anchor id. Legacy maps are still
        # remapped geometrically so existing sessions can be rebased.
        for index in list(indices):
            anchor_id = fields[index].get("anchorId") or fields[index].get("anchor_id")
            if anchor_id and anchor_id in by_id:
                assigned[index] = by_id[anchor_id]
                indices.remove(index)
        candidates.sort(key=lambda item: (
            (float(item[0]["top"]) + float(item[0]["bottom"])) / 2,
            float(item[0]["x0"]),
        ))
        indices.sort(key=lambda i: (
            (float(fields[i]["box"][1]) + float(fields[i]["box"][3])) / 2,
            float(fields[i]["box"][0]),
        ))
        assigned.update(_assign_in_order(fields, indices, candidates))

    for index in snappable:
        field = fields[index]
        match = assigned.get(index)
        if match is None:
            field["anchor_kind"] = "none"
            continue
        candidate, kind = match
        x0, top, x1, bottom = (float(v) for v in field["box"])
        new_top, new_bottom = float(candidate["top"]), float(candidate["bottom"])
        new_x0, new_x1 = x0, x1
        if kind in ("empty_box", "cell", "placeholder"):
            new_x0 = max(x0, float(candidate["x0"]))
            new_x1 = min(x1, float(candidate["x1"]))
            if kind == "placeholder" or new_x1 - new_x0 < MIN_SNAPPED_WIDTH_PT:
                new_x0, new_x1 = float(candidate["x0"]), float(candidate["x1"])

        moved = max(
            abs(new_top - top),
            abs(new_bottom - bottom),
            abs(new_x0 - x0),
            abs(new_x1 - x1),
        )
        field["box"] = [round(new_x0, 2), round(new_top, 2),
                        round(new_x1, 2), round(new_bottom, 2)]
        field["anchor_kind"] = kind
        field["anchorId"] = candidate.get("anchor_id")
        if candidate.get("replace_box"):
            field["replace_box"] = candidate["replace_box"]
        field["anchor_snapped"] = moved > SNAP_EPSILON_PT
        # Entry areas read correctly bottom-aligned: the value sits ON the
        # line, like handwriting, instead of floating in the middle of the row.
        field.setdefault("valign", "bottom")

    return fields


def _match_cost(
    x0: float, top: float, x1: float, bottom: float, candidate: dict
) -> float | None:
    """Distance between a field and an entry; None when implausible."""
    cx0, cx1 = float(candidate["x0"]), float(candidate["x1"])
    ctop, cbottom = float(candidate["top"]), float(candidate["bottom"])
    width = max(1e-6, x1 - x0)
    x_overlap = min(x1, cx1) - max(x0, cx0)
    if x_overlap <= MIN_X_OVERLAP_RATIO * min(width, max(1e-6, cx1 - cx0)):
        return None
    distance = abs(((ctop + cbottom) / 2) - ((top + bottom) / 2))
    if distance > MAX_CENTER_SHIFT_PT:
        return None
    return distance


def _assign_in_order(
    fields: list[dict[str, Any]],
    indices: list[int],
    candidates: list[tuple[dict, str]],
) -> dict[int, tuple[dict, str]]:
    """Cheapest order-preserving matching of fields to entries.

    Sequence alignment, not nearest-neighbour: fields and entries are both in
    reading order, every field may stay unanchored at a fixed penalty, and
    entries may go unused for free (a page has more entry positions than the
    form asks the bidder to complete). Leaving a value unanchored costs more
    than any plausible pairing, so pairing wins whenever one exists.
    """
    n, m = len(indices), len(candidates)
    # Dominates any sum of distances: a value that CAN sit on an entry always
    # should. Otherwise a uniformly offset column is "cheapest" when the first
    # value is abandoned and the rest slide up a row — which is the very bug
    # this pass exists to prevent. Implausible pairs are infinite, so a field
    # with nowhere to go is still left alone; distance only orders the
    # complete assignments.
    unanchored_penalty = 1e6
    inf = float("inf")

    cost = [[inf] * m for _ in range(n)]
    for i, index in enumerate(indices):
        x0, top, x1, bottom = (float(v) for v in fields[index]["box"])
        for j, (candidate, _kind) in enumerate(candidates):
            value = _match_cost(x0, top, x1, bottom, candidate)
            if value is not None:
                cost[i][j] = value

    # dp[i][j]: best total for the first i fields against the first j entries.
    dp = [[inf] * (m + 1) for _ in range(n + 1)]
    back: list[list[str]] = [[""] * (m + 1) for _ in range(n + 1)]
    dp[0][0] = 0.0
    for j in range(1, m + 1):
        dp[0][j] = 0.0
        back[0][j] = "skip_entry"
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] + unanchored_penalty
        back[i][0] = "skip_field"
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            best, move = dp[i - 1][j] + unanchored_penalty, "skip_field"
            if dp[i][j - 1] < best:
                best, move = dp[i][j - 1], "skip_entry"
            pair = cost[i - 1][j - 1]
            if pair != inf and dp[i - 1][j - 1] + pair < best:
                best, move = dp[i - 1][j - 1] + pair, "pair"
            dp[i][j], back[i][j] = best, move

    assigned: dict[int, tuple[dict, str]] = {}
    i, j = n, m
    while i > 0 and j > 0:
        move = back[i][j]
        if move == "pair":
            assigned[indices[i - 1]] = candidates[j - 1]
            i, j = i - 1, j - 1
        elif move == "skip_field":
            i -= 1
        else:
            j -= 1
    return assigned


def snap_summary(fieldmap: list[dict[str, Any]]) -> dict[str, int]:
    text_fields = [f for f in fieldmap if f.get("kind") == "text"]
    return {
        "snapped": sum(1 for f in text_fields if f.get("anchor_snapped")),
        "unanchored": sum(1 for f in text_fields if f.get("anchor_kind") == "none"),
        "textFields": len(text_fields),
    }
