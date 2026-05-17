from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Fade:
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


@dataclass
class Morph:
    element: str
    from_state: str
    to_state: str
    step: int = 1


@dataclass
class Slide:
    src: str
    animations: list = field(default_factory=list)

    @property
    def step_count(self) -> int:
        return max((a.step for a in self.animations), default=0)


class Deck:
    def __init__(self, main: str = None):
        self.main = main
        self.slides: list[Slide] = []
