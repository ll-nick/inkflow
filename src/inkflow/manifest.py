from __future__ import annotations

from dataclasses import dataclass, field
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


@dataclass
class TextBox:
    element: str
    src: str | None = None
    text: str | None = None
    steps: bool = False


@dataclass
class Image:
    element: str
    src: str


@dataclass
class Video:
    element: str
    src: str


Content = TextBox | Image | Video


# ── Slide / Deck ──────────────────────────────────────────────────────────────


@dataclass
class Slide:
    src: str
    animations: list[Animation] = field(default_factory=list)
    transition: Transition | None = None
    content: list[Content] = field(default_factory=list)
    style: str = ""

    @property
    def step_count(self) -> int:
        return max((a.step for a in self.animations), default=0)


class MarkdownSlide:
    layout: str
    src: str | None
    steps: bool
    animations: list[Animation]
    transition: Transition | None
    style: str
    _extra: dict[str, str]

    def __init__(
        self,
        layout: str,
        *,
        src: str | None = None,
        steps: bool = False,
        animations: list[Animation] | None = None,
        transition: Transition | None = None,
        style: str = "",
        **kwargs: str,
    ) -> None:
        self.layout = layout
        self.src = src
        self.steps = steps
        self.animations = animations or []
        self.transition = transition
        self.style = style
        self._extra = kwargs


class Deck:
    slides: list[Slide | MarkdownSlide]
    transition: Transition | None
    themes: dict[str, str]
    style: str
    font_size: int

    def __init__(
        self,
        transition: Transition | None = None,
        themes: dict[str, str] | None = None,
        style: str = "",
        font_size: int = 36,
    ) -> None:
        self.slides = []
        self.transition = transition
        self.themes = themes or {}
        self.style = style
        self.font_size = font_size
