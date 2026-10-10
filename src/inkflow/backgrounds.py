"""A background behind a picture (``Image(background=...)``, ``inkflow:background``).

Figures made for paper (a PDF from a LaTeX paper, a plot exported as SVG or
transparent PNG) draw black lines on nothing: on a dark deck they vanish. A
background painted behind the picture, with a small margin, fixes that
without editing the figure.

In a zone the picture is an HTML ``<img>`` and gets it as CSS; a slide's own
``<image>`` (or a draw.io diagram drawn into the slide) gets a ``<rect>``
behind it, added by the pipeline only, so the slide's file stays as written.
"""

from __future__ import annotations

import re

from lxml import etree

from inkflow.colors import SVG_TOKENS
from inkflow.logging import logger
from inkflow.ns import INKFLOW_BACKGROUND, INKFLOW_BACKGROUND_PADDING, SVG
from inkflow.svgio import SvgElement

PAPER = "#ffffff"
"""White whatever the deck's mode: what a figure for print was drawn on."""

_HEX = re.compile(r"#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})")

MARGIN = 0.04
"""The margin around the picture, as a share of its shorter side."""


def background_paint(value: str) -> str:
    """The CSS paint for a background value: ``paper``, ``surface`` (the
    theme's), a theme colour name, or ``#rgb``/``#rrggbb``."""
    v = value.strip()
    if v == "paper":
        return PAPER
    if v == "surface" or v in SVG_TOKENS:
        return f"var(--inkflow-{v})"
    if _HEX.fullmatch(v):
        return v
    raise ValueError(
        f"background {value!r}: use paper, surface, a theme colour "
        + "(blue, green, …) or #rrggbb"
    )


def _number(el: SvgElement, name: str) -> float:
    try:
        return float(el.get(name) or 0)
    except ValueError:
        return 0.0


def picture_backgrounds(root: SvgElement) -> SvgElement:
    """A ``<rect>`` behind each picture that asks for a background."""
    pictures = [
        el
        for el in root.iter(f"{{{SVG}}}image", f"{{{SVG}}}svg")
        if el.get(INKFLOW_BACKGROUND) and el is not root
    ]
    for el in pictures:
        value = el.get(INKFLOW_BACKGROUND) or ""
        try:
            paint = background_paint(value)
        except ValueError as exc:
            logger.warning(f"#{el.get('id') or 'a picture'}: {exc}")
            continue
        x, y = _number(el, "x"), _number(el, "y")
        w, h = _number(el, "width"), _number(el, "height")
        if w <= 0 or h <= 0:
            continue
        try:
            pad = float(el.get(INKFLOW_BACKGROUND_PADDING) or "nan")
        except ValueError:
            pad = float("nan")
        if pad != pad:  # not given: a margin in proportion to the picture
            pad = round(min(w, h) * MARGIN, 2)
        rect = etree.Element(
            f"{{{SVG}}}rect",
            {
                "x": f"{x - pad:g}",
                "y": f"{y - pad:g}",
                "width": f"{w + 2 * pad:g}",
                "height": f"{h + 2 * pad:g}",
                "rx": f"{min(pad, 12):g}",
                "class": "inkflow-picture-background",
                # Clicks go to the picture, which is what the editor selects.
                "pointer-events": "none",
                "style": f"fill: {paint}",
            },
        )
        transform = el.get("transform")
        if transform:
            rect.set("transform", transform)
        parent = el.getparent()
        if parent is not None:
            parent.insert(parent.index(el), rect)
    return root
