from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum, auto
from typing import TypeAlias

# ── Shared enum base ──────────────────────────────────────────────────────────


class _KebabStrEnum(StrEnum):
    @staticmethod
    def _generate_next_value_(  # pyright: ignore[reportImplicitOverride]
        name: str, start: int, count: int, last_values: list[str]
    ) -> str:
        return name.lower().replace("_", "-")


# ── Content marker ────────────────────────────────────────────────────────────


class Inline(str):
    """Marks a string as literal content rather than a file path.

    Fields typed as ``Content`` interpret a bare ``str`` as a file path to read.
    Wrapping the value in ``Inline(...)`` signals that the string itself is the
    content — rendered as Markdown for ``notes``/``md``, or used as CSS for
    ``style``/``extra_style``.

    .. code-block:: python

        Slide("content", notes=Inline("Talk through the diagram."))
        Slide("content", md=Inline("# Quick slide\\n\\nNo .md file needed."))
        Deck(style=Inline("rect { fill: red; }"))
    """


Content: TypeAlias = "str | Inline | None"

# ── Animation ────────────────────────────────────────────────────────────────


class Direction(_KebabStrEnum):
    LEFT = auto()
    RIGHT = auto()
    UP = auto()
    DOWN = auto()


@dataclass
class Animation:
    """Data-only base for every animation type.

    Concrete types live in ``inkflow.animations`` and subclass this, adding only
    their own fields. The shared timing params are ``kw_only`` so they stay out of
    the positional argument order, leaving the natural positional slots to each
    subclass's own fields (e.g. ``SlideIn("#box", Direction.RIGHT)`` sets
    ``direction``).

    A value of ``None`` means "emit no CSS custom property" so the stylesheet's
    ``var(--anim-…, default)`` fallback wins. The CSS is the single source of
    default values.
    """

    element: str
    step: int = 1
    duration: float | None = field(default=None, kw_only=True)
    easing: str | None = field(default=None, kw_only=True)
    delay: float | None = field(default=None, kw_only=True)


# ── Transition ────────────────────────────────────────────────────────────────


@dataclass
class Transition:
    """Data-only base for every transition type.

    Concrete types live in ``inkflow.transitions`` and subclass this.
    A value of ``None`` for ``easing`` means the JS handler's built-in default wins.
    """

    duration: float = 0.5
    easing: str | None = field(default=None, kw_only=True)


# ── Content types ─────────────────────────────────────────────────────────────


class Align(_KebabStrEnum):
    LEFT = auto()
    CENTER = auto()
    RIGHT = auto()
    JUSTIFY = auto()


class VAlign(_KebabStrEnum):
    TOP = auto()
    CENTER = auto()
    BOTTOM = auto()


class MediaFit(_KebabStrEnum):
    CONTAIN = auto()
    COVER = auto()
    FILL = auto()
    NONE = auto()
    SCALE_DOWN = auto()


class MediaAlign(_KebabStrEnum):
    CENTER = auto()
    TOP = auto()
    BOTTOM = auto()
    LEFT = auto()
    RIGHT = auto()
    TOP_LEFT = auto()
    TOP_RIGHT = auto()
    BOTTOM_LEFT = auto()
    BOTTOM_RIGHT = auto()


class ColorMode(_KebabStrEnum):
    DARK = auto()
    LIGHT = auto()


@dataclass
class TextBox:
    text: str | None = None
    align: Align | None = None
    valign: VAlign | None = None
    padding: float | None = None  # SVG user units. Fall back to CSS if not set.


@dataclass
class Media:
    src: str
    alt_src: str | None = None
    fit: MediaFit = MediaFit.CONTAIN
    align: MediaAlign = MediaAlign.CENTER
    x: float = 0.0
    y: float = 0.0


ZoneContent = str | Media | TextBox


# ── Slide / Deck ──────────────────────────────────────────────────────────────


@dataclass
class Slide:
    src: str  # SVG path or bare layout name
    id: str | None = None  # stable identifier; auto-inferred from md/src stem if unset
    md: Content = None  # .md file path, or Inline("...") for inline markdown
    zones: dict[str, ZoneContent] = field(
        default_factory=dict
    )  # per-zone overrides; str = inline markdown
    animations: list[Animation] = field(default_factory=list)
    transition: Transition | None = None
    extra_style: Content = None  # CSS string or path; appended to Deck.style
    title: str | None = None
    notes: Content = None  # speaker notes: Inline("...") or path to .md file
    visible: bool = True
    font_size: int | None = None

    @property
    def step_count(self) -> int:
        return max((a.step for a in self.animations), default=0)


@dataclass
class Deck:
    slides: list[Slide] = field(default_factory=list)
    transition: Transition | None = None
    theme: str | None = None
    mode: ColorMode = ColorMode.DARK
    style: Content = None  # CSS applied to every slide; Inline("...") or path
    font_size: int = 36
    embed_fonts: bool = True
