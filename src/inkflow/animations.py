"""Built-in animation types for the deck DSL.

Each type is a thin subclass of ``Animation``, adding only
its own fields. The shared params (``duration``, ``easing``, ``delay``) and the
``element``/``step`` fields come from the base.

How a type maps to CSS:

- The CSS class is ``anim-<slug>``, where the slug is the kebab-cased class name
  (``Animation.slug()``): ``FadeIn`` → ``anim-fade-in``, ``SlideIn`` →
  ``anim-slide-in``, ``Highlight`` → ``anim-highlight``. Defining a new type is
  "add a subclass here + write a matching CSS rule," nothing else.
- Continuous params become ``--anim-<field>`` custom properties on the element.
- Discrete params that CSS cannot branch on by value become modifier classes —
  currently ``direction`` → ``anim-from-{direction}``.
"""

from __future__ import annotations

from dataclasses import dataclass

from inkflow.enums import Direction
from inkflow.manifest import Animation

__all__ = [
    "Bounce",
    "FadeIn",
    "FadeOut",
    "Highlight",
    "SlideIn",
    "SlideOut",
    "ZoomIn",
    "ZoomOut",
]


@dataclass
class FadeIn(Animation):
    """Element starts hidden, fades in on its step."""


@dataclass
class FadeOut(Animation):
    """Element starts visible, fades out on its step."""


@dataclass
class Bounce(Animation):
    """Element starts hidden, appears with a scale-pulse bounce on its step."""


@dataclass
class SlideIn(Animation):
    """Element slides in from an edge, fading as it arrives."""

    direction: Direction = Direction.LEFT
    """Edge the element slides in from."""
    distance: float | None = None
    """Travel distance in SVG user units. ``None`` keeps the CSS default."""


@dataclass
class SlideOut(Animation):
    """Element slides out toward an edge, fading as it leaves."""

    direction: Direction = Direction.LEFT
    """Edge the element slides out toward."""
    distance: float | None = None
    """Travel distance in SVG user units. ``None`` keeps the CSS default."""


@dataclass
class ZoomIn(Animation):
    """Element scales up into place from ``scale``."""

    scale: float | None = None
    """Starting scale, e.g. ``0.6``. ``None`` keeps the CSS default."""


@dataclass
class ZoomOut(Animation):
    """Element scales down out of place toward ``scale``."""

    scale: float | None = None
    """Ending scale. ``None`` keeps the CSS default."""


@dataclass
class Highlight(Animation):
    """Pulse the element ``passes`` times without hiding it."""

    color: str | None = None
    """Glow color (any CSS color). ``None`` keeps the CSS default."""
    passes: int | None = None
    """Number of pulses. ``None`` keeps the CSS default."""
