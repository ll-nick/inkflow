from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from pathlib import Path
from typing import Protocol, runtime_checkable

# ── Animation ────────────────────────────────────────────────────────────────


@dataclass
class FadeIn:
    element: str
    step: int = 1


@dataclass
class FadeOut:
    element: str
    step: int = 1


@dataclass
class Bounce:
    element: str
    step: int = 1


@runtime_checkable
class Animation(Protocol):
    element: str
    step: int


# ── Transition ────────────────────────────────────────────────────────────────


@dataclass
class Cut:
    duration: float = 0.0


@dataclass
class Crossfade:
    duration: float = 0.4


@dataclass
class Morph:
    duration: float = 0.5


@runtime_checkable
class Transition(Protocol):
    duration: float


# ── Content types ─────────────────────────────────────────────────────────────


class Align(StrEnum):
    LEFT = "left"
    CENTER = "center"
    RIGHT = "right"
    JUSTIFY = "justify"


class VAlign(StrEnum):
    TOP = "top"
    MIDDLE = "middle"
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
