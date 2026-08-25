"""Locale-correct value rendering.

Values arrive from chat, a database or an ERP export as `2450000.0` and
`2026-07-17`; a model asked to "format this nicely" will produce
`2,450,000.00` and `07/17/2026` some fraction of the time — which on a German
tender document reads as either wrong or foreign.

Formatting is a deterministic transform. Do it in code, declare the type in the
fieldmap, and the model never gets a vote:

    {"id": "umsatz_2025", "value_type": "eur", "value": 2450000}
    -> "2.450.000,00"
"""
from __future__ import annotations

import datetime as _dt
import re
from decimal import Decimal, InvalidOperation
from typing import Any

# ---------------------------------------------------------------- primitives

def de_number(v: Any, decimals: int = 2) -> str:
    """1234567.5 -> '1.234.567,50'  (thousands '.', decimal ',')"""
    d = _to_decimal(v)
    if d is None:
        return str(v)
    s = f"{d:,.{decimals}f}"                       # 1,234,567.50
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")


def de_eur(v: Any, decimals: int = 2, symbol: bool = False) -> str:
    n = de_number(v, decimals)
    return f"{n} €" if symbol else n


def de_date(v: Any) -> str:
    """Accepts date/datetime, ISO strings, or already-German strings."""
    if isinstance(v, (_dt.date, _dt.datetime)):
        return v.strftime("%d.%m.%Y")
    s = str(v).strip()
    if re.fullmatch(r"\d{2}\.\d{2}\.\d{4}", s):
        return s
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y"):
        try:
            return _dt.datetime.strptime(s, fmt).strftime("%d.%m.%Y")
        except ValueError:
            continue
    return s


def de_integer(v: Any) -> str:
    return de_number(v, decimals=0)


def de_percent(v: Any, decimals: int = 1) -> str:
    return f"{de_number(v, decimals)} %"


def de_phone(v: Any) -> str:
    """Normalise to +49 style, keeping the caller's grouping if sensible."""
    s = re.sub(r"[^\d+]", " ", str(v)).strip()
    s = re.sub(r"\s+", " ", s)
    if s.startswith("0") and not s.startswith("00"):
        s = "+49 " + s[1:].lstrip()
    return s


def plain(v: Any) -> str:
    return "" if v is None else str(v)


FORMATTERS = {
    "eur":      de_eur,
    "eur_sym":  lambda v: de_eur(v, symbol=True),
    "number":   de_number,
    "integer":  de_integer,
    "percent":  de_percent,
    "date":     de_date,
    "phone":    de_phone,
    "text":     plain,
}


def _to_decimal(v: Any) -> Decimal | None:
    if isinstance(v, Decimal):
        return v
    if isinstance(v, (int, float)):
        return Decimal(str(v))
    s = str(v).strip()
    if not s:
        return None
    # tolerate a German-formatted string arriving as input
    if re.fullmatch(r"-?\d{1,3}(\.\d{3})*(,\d+)?", s):
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    try:
        return Decimal(s)
    except InvalidOperation:
        return None


# ------------------------------------------------------------------- api

def apply_formats(fieldmap: list[dict]) -> list[dict]:
    """Render every field's raw value through its declared type.

    Run this BEFORE validation, so the width checks measure the string that will
    actually be drawn — '2.450.000,00' is wider than '2450000.0' and a box that
    fits the raw value may not fit the formatted one."""
    out = []
    for f in fieldmap:
        f = dict(f)
        vt = f.get("value_type", "text")
        if "value" in f and vt in FORMATTERS:
            try:
                f["value"] = FORMATTERS[vt](f["value"])
            except Exception:
                f["value"] = plain(f.get("value"))
        out.append(f)
    return out


def truncation_hint(value: str, limit: int) -> str:
    """German forms often cap a field. Truncate on a word boundary with an
    ellipsis rather than mid-word, and never silently — the caller should
    surface this as a warning."""
    if len(value) <= limit:
        return value
    cut = value[:limit - 1].rsplit(" ", 1)[0]
    return (cut or value[:limit - 1]) + "…"
