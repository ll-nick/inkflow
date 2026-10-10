"""Page sizes: what a deck is drawn on (its canvas) and printed at (its page).

A `PageSize` is a string naming a size (``"16:9"``, ``"a0"``,
``"a1-landscape"``, ``"841x1189mm"``, ``"1920x1080"``) with what follows from
it worked out once:

- the **canvas**: the user units a new slide's ``viewBox`` gets, which the
  theme's px sizes are measured in;
- the **page**: the physical sheet a PDF page is, in points (1/72 in);
- whether it is a **print** size (paper, a poster) or a **screen** one.

The rules, so a number means the same everywhere:

- Screen ratios keep 1080 units on the shorter side (16:9 is 1920x1080, 4:3
  1440x1080, 9:16 1080x1920), the size the theme's type scale is drawn for.
  Their page is the canvas at 1 unit = 1 CSS px (1/96 in), as PDFs always were.
- The ISO A sizes share one canvas, A0's at 1 unit = 1 CSS px (3179x4494, or
  4494x3179 landscape): they are one shape at different scales, so a poster
  drawn once prints at any of them, and its text scales with the sheet.
- Every other physical size (letter, ``841x1189mm``, ``36x48in``) is its sheet
  at 1 unit = 1 CSS px.
"""

from __future__ import annotations

import re
from typing import ClassVar

__all__ = ["PageSize"]

MM_PER_IN = 25.4
PX_PER_IN = 96.0
PT_PER_IN = 72.0

SCREEN_SHORT = 1080.0
"""Units on the shorter side of a screen ratio: the theme's type scale is
drawn for a 1080-high slide."""

PRINT_TEXT_RATIO = 80.0
"""On paper, body text is the sheet's shorter side over this (30 pt on A0)."""

PRINT_MIN_BODY_PT = 10.0
"""The smallest body text a print size gets by default (A4, letter)."""

_A_MM: dict[int, tuple[float, float]] = {
    0: (841, 1189),
    1: (594, 841),
    2: (420, 594),
    3: (297, 420),
    4: (210, 297),
    5: (148, 210),
}

_PAPER_IN: dict[str, tuple[float, float]] = {
    "letter": (8.5, 11),
    "legal": (8.5, 14),
    "tabloid": (11, 17),
}

_RATIOS: dict[str, tuple[int, int]] = {
    "16:9": (16, 9),
    "16:10": (16, 10),
    "4:3": (4, 3),
    "1:1": (1, 1),
    "3:4": (3, 4),
    "9:16": (9, 16),
}

_ALIASES = {
    "widescreen": "16:9",
    "standard": "4:3",
    "square": "1:1",
    "phone": "9:16",
    "story": "9:16",
}

_UNIT_PT = {
    "mm": PT_PER_IN / MM_PER_IN,
    "cm": PT_PER_IN / MM_PER_IN * 10,
    "in": PT_PER_IN,
    "pt": 1.0,
    "px": PT_PER_IN / PX_PER_IN,
}

_CUSTOM = re.compile(
    r"^(?P<w>\d+(?:\.\d+)?)x(?P<h>\d+(?:\.\d+)?)(?P<unit>mm|cm|in|pt|px)?$"
)

# A0 at 1 unit = 1 CSS px: the canvas every A size shares.
_A0_CANVAS = (
    round(_A_MM[0][0] / MM_PER_IN * PX_PER_IN),
    round(_A_MM[0][1] / MM_PER_IN * PX_PER_IN),
)


def _g(value: float) -> str:
    """A number as written in a size: no trailing zeros, at most 3 decimals."""
    return f"{round(value, 3):g}"


def _normalize(value: str) -> str:
    text = value.strip().lower().replace("\u00d7", "x").replace("_", "-")
    text = re.sub(r"\s*x\s*", "x", text)
    text = re.sub(r"\s+", "-", text)
    text = _ALIASES.get(text, text)
    text = text.removesuffix("-portrait")
    if text.endswith("px") and _CUSTOM.match(text):
        text = text.removesuffix("px")  # px is what a bare WxH means
    return text


class PageSize(str):
    """The size of a deck: the canvas its slides are drawn on and the page it
    prints at.

    A plain string works wherever a size is taken (``Deck(size="a0")``); the
    constructors build the custom ones.

    ```python
    Deck(size="16:9")                     # the default: 1920x1080
    Deck(size="a0")                       # an A0 portrait poster
    Deck(size="a1-landscape")
    Deck(size=PageSize.mm(600, 900))      # any sheet, in mm, cm or inches
    Deck(size=PageSize.inches(36, 48))
    Deck(size=PageSize.px(1280, 720))     # a screen canvas in px
    ```

    Presets: ``"16:9"``, ``"16:10"``, ``"4:3"``, ``"1:1"``, ``"3:4"``,
    ``"9:16"`` (also ``"phone"``), ``"a0"`` to ``"a5"`` and
    ``"a0-landscape"`` to ``"a5-landscape"``, ``"letter"``, ``"legal"`` and
    ``"tabloid"`` (each with ``-landscape``).
    """

    WIDESCREEN: ClassVar[PageSize]
    """16:9, 1920x1080: the default."""
    STANDARD: ClassVar[PageSize]
    """4:3, 1440x1080."""
    PHONE: ClassVar[PageSize]
    """9:16 portrait, 1080x1920."""
    A0: ClassVar[PageSize]
    """ISO A0 portrait, 841x1189 mm: the usual conference poster."""
    A1: ClassVar[PageSize]
    """ISO A1 portrait, 594x841 mm."""
    A2: ClassVar[PageSize]
    """ISO A2 portrait, 420x594 mm."""
    A3: ClassVar[PageSize]
    """ISO A3 portrait, 297x420 mm."""
    A4: ClassVar[PageSize]
    """ISO A4 portrait, 210x297 mm."""
    LETTER: ClassVar[PageSize]
    """US letter portrait, 8.5x11 in."""

    _canvas: tuple[float, float]
    _page_pt: tuple[float, float]
    _page_css: tuple[str, str]
    _print: bool
    _label: str

    def __new__(cls, value: str) -> PageSize:
        if isinstance(value, PageSize):
            return value
        text = _normalize(str(value))
        spec = _resolve(text)
        if spec is None:
            raise ValueError(
                f"unknown page size {value!r}: use 16:9, 4:3, 9:16, a0 … a5"
                + " (add -landscape), letter, or WxH with mm, cm, in or px"
                + " (841x1189mm, 1920x1080)"
            )
        self = super().__new__(cls, text)
        self._canvas, self._page_pt, self._page_css, self._print, self._label = spec
        return self

    # ── Constructors ──

    @classmethod
    def mm(cls, width: float, height: float) -> PageSize:
        """A sheet ``width`` by ``height`` millimetres."""
        return cls(f"{_g(width)}x{_g(height)}mm")

    @classmethod
    def cm(cls, width: float, height: float) -> PageSize:
        """A sheet ``width`` by ``height`` centimetres."""
        return cls(f"{_g(width)}x{_g(height)}cm")

    @classmethod
    def inches(cls, width: float, height: float) -> PageSize:
        """A sheet ``width`` by ``height`` inches."""
        return cls(f"{_g(width)}x{_g(height)}in")

    @classmethod
    def px(cls, width: float, height: float) -> PageSize:
        """A screen canvas ``width`` by ``height`` px (1 px = 1/96 in in a PDF)."""
        return cls(f"{_g(width)}x{_g(height)}")

    # ── What it means ──

    @property
    def canvas(self) -> tuple[float, float]:
        """Width and height of a slide's ``viewBox``, in user units."""
        return self._canvas

    @property
    def page_pt(self) -> tuple[float, float]:
        """Width and height of a printed page, in points (1/72 in)."""
        return self._page_pt

    @property
    def page_css(self) -> tuple[str, str]:
        """Width and height of a printed page as CSS lengths (``841mm``)."""
        return self._page_css

    @property
    def is_print(self) -> bool:
        """A sheet of paper (A sizes, letter, mm/cm/in/pt sizes), not a screen."""
        return self._print

    @property
    def label(self) -> str:
        """For people: ``A0 portrait (841 x 1189 mm)``, ``16:9 (1920 x 1080)``."""
        return self._label

    @property
    def aspect(self) -> float:
        """Width over height of the canvas."""
        return self._canvas[0] / self._canvas[1]

    @property
    def pt_per_unit(self) -> float:
        """Printed points per canvas unit (a slide fitted onto the page)."""
        return min(
            self._page_pt[0] / self._canvas[0], self._page_pt[1] / self._canvas[1]
        )

    def landscape(self) -> PageSize:
        """This size turned so its longer side is horizontal."""
        w, h = self._canvas
        return self if w >= h else self.rotated()

    def portrait(self) -> PageSize:
        """This size turned so its longer side is vertical."""
        w, h = self._canvas
        return self if h >= w else self.rotated()

    def rotated(self) -> PageSize:
        """This size turned a quarter: portrait to landscape and back."""
        text = str(self)
        if text.endswith("-landscape"):
            return PageSize(text.removesuffix("-landscape"))
        if text in _RATIOS:
            a, b = _RATIOS[text]
            rotated = f"{b}:{a}"
            if rotated in _RATIOS:
                return PageSize(rotated)
            w, h = self._canvas
            return PageSize.px(h, w)
        if m := _CUSTOM.match(text):
            return PageSize(f"{m['h']}x{m['w']}{m['unit'] or ''}")
        return PageSize(f"{text}-landscape")

    def base_font(self, theme_size: float) -> int:
        """The body text size (units) a deck of this size gets by default, for a
        theme whose type scale is ``theme_size`` px on a 1080-high screen.

        A screen size keeps the theme's proportions (its shorter side over
        1080). On paper body text is the sheet's shorter side over 80 (30 pt
        on A0, 21 pt on A1, 15 pt on A2), never below 10 pt; a theme with a
        larger or smaller type scale moves it in proportion.
        """
        short = min(self._canvas)
        if not self._print:
            return max(1, round(theme_size * short / SCREEN_SHORT))
        body = print_body_pt(*self._page_pt) / self.pt_per_unit
        return max(1, round(theme_size / 36 * body))

    @property
    def chart_text_scale(self) -> float:
        """A chart's text size relative to the body text: larger on paper, where
        a figure is read from a step back rather than projected large."""
        return 1.0 if self._print else 0.6


_Spec = tuple[tuple[float, float], tuple[float, float], tuple[str, str], bool, str]


def _resolve(text: str) -> _Spec | None:
    landscape = text.endswith("-landscape")
    base = text.removesuffix("-landscape")
    if base in _RATIOS and not landscape:
        a, b = _RATIOS[base]
        scale = SCREEN_SHORT / min(a, b)
        w, h = a * scale, b * scale
        return _screen((w, h), f"{base} ({_g(w)} x {_g(h)})")
    if (m := re.fullmatch(r"a(\d)", base)) and int(m[1]) in _A_MM:
        wm, hm = _A_MM[int(m[1])]
        cw, ch = _A0_CANVAS
        if landscape:
            wm, hm, cw, ch = hm, wm, ch, cw
        k = PT_PER_IN / MM_PER_IN
        orientation = "landscape" if landscape else "portrait"
        return (
            (float(cw), float(ch)),
            (wm * k, hm * k),
            (f"{_g(wm)}mm", f"{_g(hm)}mm"),
            True,
            f"A{m[1]} {orientation} ({_g(wm)} x {_g(hm)} mm)",
        )
    if base in _PAPER_IN:
        wi, hi = _PAPER_IN[base]
        if landscape:
            wi, hi = hi, wi
        orientation = " landscape" if landscape else ""
        return _physical(
            wi, hi, "in", f"{base.capitalize()}{orientation} ({_g(wi)} x {_g(hi)} in)"
        )
    if landscape:
        return None
    m = _CUSTOM.match(base)
    if m is None:
        return None
    w, h, unit = float(m["w"]), float(m["h"]), m["unit"] or "px"
    if w <= 0 or h <= 0:
        return None
    if unit == "px":
        if not (16 <= w <= 20000 and 16 <= h <= 20000):
            return None
        return _screen((w, h), f"{_g(w)} x {_g(h)} px")
    return _physical(w, h, unit, f"{_g(w)} x {_g(h)} {unit}")


def _screen(canvas: tuple[float, float], label: str) -> _Spec:
    w, h = canvas
    k = PT_PER_IN / PX_PER_IN
    return (canvas, (w * k, h * k), (f"{_g(w)}px", f"{_g(h)}px"), False, label)


def _physical(w: float, h: float, unit: str, label: str) -> _Spec | None:
    pt = _UNIT_PT[unit]
    wp, hp = w * pt, h * pt
    # A sheet from a postage stamp to a 5 m banner.
    if not (36 <= wp <= 14400 and 36 <= hp <= 14400):
        return None
    px = PX_PER_IN / PT_PER_IN
    canvas = (float(round(wp * px)), float(round(hp * px)))
    return (canvas, (wp, hp), (f"{_g(w)}{unit}", f"{_g(h)}{unit}"), True, label)


def physical_length_pt(value: str | None) -> float | None:
    """An SVG root's ``width``/``height`` in points, when it is given in an
    absolute unit (``841mm``, ``33.1in``); ``None`` for px, % or nothing."""
    if not value:
        return None
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?|\.\d+)\s*(mm|cm|in|pt|pc)\s*", value)
    if m is None:
        return None
    unit = m[2]
    factor = 12.0 if unit == "pc" else _UNIT_PT[unit]
    return float(m[1]) * factor


def parse_view_box(text: str | None) -> tuple[float, float, float, float] | None:
    """An SVG ``viewBox`` as ``(x, y, width, height)``, or ``None`` when it is
    missing, malformed or empty."""
    parts = (text or "").replace(",", " ").split()
    if len(parts) != 4:
        return None
    try:
        x, y, w, h = (float(p) for p in parts)
    except ValueError:
        return None
    return (x, y, w, h) if w > 0 and h > 0 else None


def print_body_pt(width_pt: float, height_pt: float) -> float:
    """The body text size a sheet of paper is read at, in points: its shorter
    side over 80 (30 pt on A0, 21 pt on A1), never below 10 pt. What
    `PageSize.base_font` gives a print deck, and what `inkflow render` checks
    printed text against."""
    return max(min(width_pt, height_pt) / PRINT_TEXT_RATIO, PRINT_MIN_BODY_PT)


ASPECT_TOLERANCE = 0.01
"""How far apart two aspect ratios may be and still count as the same shape
(the A sizes differ by under 0.1% from rounding to whole millimetres)."""


def same_aspect(a: tuple[float, float], b: tuple[float, float]) -> bool:
    """Whether two ``(width, height)`` boxes have the same shape."""
    ra, rb = a[0] / a[1], b[0] / b[1]
    return abs(ra - rb) / rb <= ASPECT_TOLERANCE


PageSize.WIDESCREEN = PageSize("16:9")
PageSize.STANDARD = PageSize("4:3")
PageSize.PHONE = PageSize("9:16")
PageSize.A0 = PageSize("a0")
PageSize.A1 = PageSize("a1")
PageSize.A2 = PageSize("a2")
PageSize.A3 = PageSize("a3")
PageSize.A4 = PageSize("a4")
PageSize.LETTER = PageSize("letter")
