"""Built-in transition types for the deck DSL.

Each type is a thin subclass of ``Transition``, adding only
its own fields. The shared params (``duration``, ``easing``) come from the base.

How a type maps to the JS handler:

- The handler key is the kebab-cased class name (``Transition.slug()``):
  ``SomeTransition`` → ``"some-transition"``
- Every set (non-``None``) field is serialized into the transition JSON, so
  ``direction``, ``color`` etc. arrive on the JS ``TransitionData`` object
  automatically without per-type pipeline code required.
- Register a custom handler from user JS:
  ``window.inkflow.registerTransition(name, fn)``.
"""

from __future__ import annotations

from dataclasses import dataclass

from inkflow.manifest import Direction, Transition

__all__ = [
    "Cover",
    "Crossfade",
    "Cut",
    "Fade",
    "Morph",
    "Push",
    "Wipe",
    "Zoom",
]


@dataclass
class Cut(Transition):
    """Instant slide switch with no animation."""

    duration: float = 0.0
    """Duration in seconds. Fixed at ``0.0`` (instant)."""


@dataclass
class Crossfade(Transition):
    """Dissolve the outgoing slide into the incoming one."""


@dataclass
class Morph(Transition):
    """Interpolate matching SVG elements by ID between slides.

    Elements sharing an ``id`` across the two slides tween position, size, and
    rotation to their new pose, plus ``fill``/``stroke`` color and opacity. Any
    leaf shape morphs — rects, circles, lines, paths, images, text — and text
    keeps its glyphs undistorted by tweening font size rather than a box scale.

    ``id`` a group to morph everything inside it as independently matched
    leaves; ``id`` a single element to morph just that one. Elements with no
    matching ``id`` on the other slide crossfade instead: present only in the
    outgoing slide, they fade out; present only in the incoming slide, they
    fade in.
    """


@dataclass
class Push(Transition):
    """Both slides move — outgoing exits, incoming enters from the opposite edge."""

    direction: Direction = Direction.LEFT
    """Edge the incoming slide enters from."""


@dataclass
class Cover(Transition):
    """Incoming slide covers the outgoing one, which stays in place."""

    direction: Direction = Direction.LEFT
    """Edge the incoming slide enters from."""


@dataclass
class Zoom(Transition):
    """Outgoing slide scales out while the incoming one scales in.

    ``amount`` is how far the slides scale past their normal size: 0.6 zooms the
    incoming slide in from 0.4x and the outgoing slide out to 1.6x.
    """

    amount: float = 0.6
    """How far the slides scale past their normal size."""


@dataclass
class Fade(Transition):
    """Outgoing fades to a solid colour, then the incoming fades in from it."""

    color: str = "#000000"
    """The intermediate solid color faded through."""


@dataclass
class Wipe(Transition):
    """Incoming slide is progressively revealed from one edge."""

    direction: Direction = Direction.LEFT
    """Edge the reveal starts from."""
