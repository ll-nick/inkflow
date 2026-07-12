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

from dataclasses import dataclass, field

from inkflow.enums import Direction, Easing
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

    duration: float = field(default=0.35, kw_only=True)
    """Duration in seconds."""
    overshoot: Easing = field(
        default=Easing.cubic_bezier(0.34, 1.56, 0.64, 1), kw_only=True
    )
    """Easing for the translate axis — the overshoot that gives the bounce its
    spring. Independent of the opacity-axis ``easing``."""


@dataclass
class SlideIn(Animation):
    """Element slides in from an edge, fading as it arrives."""

    direction: Direction = Direction.LEFT
    """Edge the element slides in from."""
    distance: float = 60.0
    """Travel distance in SVG user units."""


@dataclass
class SlideOut(Animation):
    """Element slides out toward an edge, fading as it leaves."""

    direction: Direction = Direction.LEFT
    """Edge the element slides out toward."""
    distance: float = 60.0
    """Travel distance in SVG user units."""


@dataclass
class ZoomIn(Animation):
    """Element scales up into place from ``scale``."""

    scale: float = 0.8
    """Starting scale, e.g. ``0.6``."""


@dataclass
class ZoomOut(Animation):
    """Element scales down out of place toward ``scale``."""

    scale: float = 0.8
    """Ending scale."""


@dataclass
class Highlight(Animation):
    """Pulse the element ``passes`` times without hiding it."""

    duration: float = field(default=0.6, kw_only=True)
    """Duration of one pulse in seconds."""
    color: str = "var(--accent)"
    """Glow color (any CSS color or theme token)."""
    passes: int = 1
    """Number of pulses."""
