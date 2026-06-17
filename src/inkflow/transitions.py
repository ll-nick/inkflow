"""Built-in transition types for the deck DSL.

Each type is a thin subclass of :class:`inkflow.manifest.Transition`, adding only
its own fields. The shared params (``duration``, ``easing``) come from the base.

How a type maps to the JS handler (see ``pipeline.py``):

- The handler key is derived from the type name via kebab-case:
  ``SomeTransition`` → ``"some-transition"``
- All fields are serialized via ``vars(t)`` into the transition JSON, so
  ``direction``, ``color`` etc. arrive on the JS ``TransitionData`` object
  automatically without per-type pipeline code required.
- Register a custom handler from user JS:
  ``window.inkflow.registerTransition(name, fn)``.
"""

from __future__ import annotations

from dataclasses import dataclass

from inkflow.manifest import Direction, Transition


@dataclass
class Cut(Transition):
    """Instant slide switch with no animation."""

    duration: float = 0.0


@dataclass
class Crossfade(Transition):
    """Dissolve the outgoing slide into the incoming one."""


@dataclass
class Morph(Transition):
    """Interpolate matching SVG elements by ID between slides."""


@dataclass
class Push(Transition):
    """Both slides move — outgoing exits, incoming enters from the opposite edge."""

    direction: Direction = Direction.LEFT


@dataclass
class Slide(Transition):
    """Incoming slide covers the outgoing one, which stays in place."""

    direction: Direction = Direction.LEFT


@dataclass
class Zoom(Transition):
    """Outgoing slide scales out while the incoming one scales in."""


@dataclass
class Fade(Transition):
    """Outgoing fades to a solid colour, then the incoming fades in from it."""

    color: str = "#000000"


@dataclass
class Wipe(Transition):
    """Incoming slide is progressively revealed from one edge."""

    direction: Direction = Direction.LEFT
