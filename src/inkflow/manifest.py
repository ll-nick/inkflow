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


# ── Slide / Deck ──────────────────────────────────────────────────────────────


@dataclass
class Slide:
    src: str
    animations: list[Animation] = field(default_factory=list)
    transition: Transition | None = None

    @property
    def step_count(self) -> int:
        return max((a.step for a in self.animations), default=0)


class Deck:
    main: str | None
    slides: list[Slide]
    transition: Transition | None

    def __init__(
        self,
        main: str | None = None,
        transition: Transition | None = None,
    ) -> None:
        self.main = main
        self.slides = []
        self.transition = transition
