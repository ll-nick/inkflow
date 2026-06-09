from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path

# ── Animation ────────────────────────────────────────────────────────────────


@dataclass
class Animation:
    """Data-only base for every animation type.

    Concrete types live in ``inkflow.animations`` and subclass this, adding only
    their own fields. The shared timing params are ``kw_only`` so they stay out of
    the positional argument order, leaving the natural positional slots to each
    subclass's own fields (e.g. ``SlideIn("#box", "right")`` sets ``direction``).

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


class Align(StrEnum):
    LEFT = "left"
    CENTER = "center"
    RIGHT = "right"
    JUSTIFY = "justify"


class VAlign(StrEnum):
    TOP = "top"
    CENTER = "center"
    BOTTOM = "bottom"


@dataclass
class TextBox:
    element: str
    text: str | None = None
    steps: bool = False
    align: Align | None = None
    valign: VAlign | None = None
    padding: float | None = None  # SVG user units. Fall back to CSS if not set.


@dataclass
class Media:
    src: str
    fit: str = "contain"
    align: str = "center"
    x: float = 0.0
    y: float = 0.0
    element: str = field(default="", kw_only=True)


Content = TextBox | Media


# ── Slide / Deck ──────────────────────────────────────────────────────────────


@dataclass
class Slide:
    src: str
    animations: list[Animation] = field(default_factory=list)
    transition: Transition | None = None
    content: list[Content] = field(default_factory=list)
    style: str = ""
    title: str | None = None
    notes: str | Path | None = None

    @property
    def step_count(self) -> int:
        return max((a.step for a in self.animations), default=0)


class MarkdownSlide:
    template: str
    content: str | None
    steps: bool
    animations: list[Animation]
    transition: Transition | None
    style: str
    title: str | None
    notes: str | Path | None
    extra: dict[str, str | Media]

    def __init__(
        self,
        template: str,
        *,
        content: str | None = None,
        steps: bool = False,
        animations: list[Animation] | None = None,
        transition: Transition | None = None,
        style: str = "",
        title: str | None = None,
        notes: str | Path | None = None,
        **kwargs: str | Media,
    ) -> None:
        self.template = template
        self.content = content
        self.steps = steps
        self.animations = animations or []
        self.transition = transition
        self.style = style
        self.title = title
        self.notes = notes
        self.extra = kwargs


class Deck:
    slides: list[Slide | MarkdownSlide]
    transition: Transition | None
    theme: str | None
    dark_mode: bool
    style: str
    font_size: int

    def __init__(
        self,
        transition: Transition | None = None,
        theme: str | None = None,
        dark_mode: bool = True,
        style: str = "",
        font_size: int = 36,
    ) -> None:
        self.slides = []
        self.transition = transition
        self.theme = theme
        self.dark_mode = dark_mode
        self.style = style
        self.font_size = font_size
