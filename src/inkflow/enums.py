"""Shared enum types used across the deck DSL.

These aren't specific to any one module — ``Direction`` is used by both
animations and transitions, ``Align``/``VAlign`` by text zones, ``MediaFit``/
``MediaAlign`` by ``Media``, and ``ColorMode`` by ``Deck``.
"""

from __future__ import annotations

import re
from enum import Enum, StrEnum, auto
from typing import ClassVar

__all__ = [
    "Align",
    "AnimationKind",
    "ColorMode",
    "Direction",
    "Easing",
    "MediaAlign",
    "MediaFit",
    "Muted",
    "Slugged",
    "Trigger",
    "VAlign",
    "camel_to_kebab",
]


# ── Type-name slug ────────────────────────────────────────────────────────────


def camel_to_kebab(name: str) -> str:
    """`FadeIn` -> `fade-in`, `SlideIn` -> `slide-in`, `Highlight` -> `highlight`."""
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()


class Slugged:
    """Mixin giving a DSL type a kebab-case slug derived from its class name."""

    @classmethod
    def slug(cls) -> str:
        return camel_to_kebab(cls.__name__)


class _KebabStrEnum(StrEnum):
    @staticmethod
    def _generate_next_value_(  # pyright: ignore[reportImplicitOverride]
        name: str, start: int, count: int, last_values: list[str]
    ) -> str:
        return name.lower().replace("_", "-")


class Direction(_KebabStrEnum):
    """Direction for animations and transitions that move along an axis.

    Used by ``SlideIn``, ``SlideOut``, ``Push``, ``Cover``, and ``Wipe``. The
    member value (``"left"``, ``"right"``, …) is the wire value sent to the
    presenter; for slide animations it resolves to the cue's ``from-x``/``from-y``
    offset.
    """

    LEFT = auto()
    """Leftward."""
    RIGHT = auto()
    """Rightward."""
    UP = auto()
    """Upward."""
    DOWN = auto()
    """Downward."""


class AnimationKind(_KebabStrEnum):
    """The role an animation plays in an element's lifecycle.

    Determines how the step engine composes several cues on one element: enters
    reveal, exits hide, and emphasis fires momentarily without changing whether the
    element is shown. The step engine keeps at most one enter/exit governing an
    element's visibility at a time, so an element can enter, be emphasized, and exit
    at different steps, and can even re-enter after an exit.

    Set on the semantic base classes (``animations.Enter``/``Exit``/``Emphasis``);
    concrete types inherit it, so authors pick a kind by which base they subclass.
    """

    ENTER = auto()
    """Reveals the element; it is hidden before this cue's step and shown after."""
    EXIT = auto()
    """Hides the element; it is shown before this cue's step and hidden after."""
    EMPHASIS = auto()
    """A momentary accent (e.g. a pulse) that leaves visibility unchanged. Plays only
    when its step is crossed going forward, never on an instant or backward landing."""


class Align(_KebabStrEnum):
    """Horizontal text alignment for a ``TextBox`` or Markdown zone."""

    LEFT = auto()
    """Left-aligned (the default when no override is set)."""
    CENTER = auto()
    """Centered."""
    RIGHT = auto()
    """Right-aligned."""
    JUSTIFY = auto()
    """Justified."""


class VAlign(StrEnum):
    """Vertical alignment of the content block inside a zone."""

    TOP = auto()
    """Anchored to the top of the zone (the default when no override is set)."""
    CENTER = auto()
    """Centered vertically."""
    BOTTOM = auto()
    """Anchored to the bottom of the zone."""


class MediaFit(_KebabStrEnum):
    """CSS ``object-fit`` preset for a ``Media`` asset.

    The member value is the literal ``object-fit`` value emitted into the style.
    """

    CONTAIN = auto()
    """Scale to fit inside the zone, preserving aspect ratio (``contain``)."""
    COVER = auto()
    """Fill the zone, cropping overflow, preserving aspect ratio (``cover``)."""
    FILL = auto()
    """Stretch to fill the zone, ignoring aspect ratio (``fill``)."""
    NONE = auto()
    """Keep intrinsic size, no scaling (``none``)."""
    SCALE_DOWN = auto()
    """The smaller of ``none`` and ``contain`` (``scale-down``)."""


class MediaAlign(_KebabStrEnum):
    """``object-position`` preset for a ``Media`` asset.

    Each member maps to an ``(x, y)`` percentage pair via ``position``, used to
    build the ``object-position`` declaration.
    """

    CENTER = auto()
    """Centered (50% 50%)."""
    TOP = auto()
    """Top edge, horizontally centered (50% 0%)."""
    BOTTOM = auto()
    """Bottom edge, horizontally centered (50% 100%)."""
    LEFT = auto()
    """Left edge, vertically centered (0% 50%)."""
    RIGHT = auto()
    """Right edge, vertically centered (100% 50%)."""
    TOP_LEFT = auto()
    """Top-left corner (0% 0%)."""
    TOP_RIGHT = auto()
    """Top-right corner (100% 0%)."""
    BOTTOM_LEFT = auto()
    """Bottom-left corner (0% 100%)."""
    BOTTOM_RIGHT = auto()
    """Bottom-right corner (100% 100%)."""

    @property
    def position(self) -> tuple[int, int]:
        """The ``object-position`` percentage pair ``(x, y)`` for this alignment."""
        return _MEDIA_ALIGN_POSITIONS[self]


_MEDIA_ALIGN_POSITIONS: dict[MediaAlign, tuple[int, int]] = {
    MediaAlign.CENTER: (50, 50),
    MediaAlign.TOP: (50, 0),
    MediaAlign.BOTTOM: (50, 100),
    MediaAlign.LEFT: (0, 50),
    MediaAlign.RIGHT: (100, 50),
    MediaAlign.TOP_LEFT: (0, 0),
    MediaAlign.TOP_RIGHT: (100, 0),
    MediaAlign.BOTTOM_LEFT: (0, 100),
    MediaAlign.BOTTOM_RIGHT: (100, 100),
}


class ColorMode(StrEnum):
    """Color mode for the presentation. Sets the ``data-theme`` attribute on
    ``<html>``, which selects the active theme CSS."""

    DARK = auto()
    """Dark theme (``data-theme=""``)."""
    LIGHT = auto()
    """Light theme (``data-theme="light"``)."""


class Easing(str):
    """A CSS easing curve for animations and transitions.

    Use a named preset for the common curves, or build a custom one with
    `cubic_bezier` or `raw`.

    ```python
    FadeIn("#a", easing=Easing.EASE_IN_OUT)
    SlideIn("#a", easing=Easing.cubic_bezier(0.2, 0, 0.3, 1))
    Highlight("#a", easing=Easing.raw("steps(4, end)"))
    ```
    """

    EASE: ClassVar[Easing]
    """The CSS ``ease`` curve (slow start, fast middle, slow end)."""
    EASE_IN: ClassVar[Easing]
    """The CSS ``ease-in`` curve (slow start)."""
    EASE_OUT: ClassVar[Easing]
    """The CSS ``ease-out`` curve (slow end)."""
    EASE_IN_OUT: ClassVar[Easing]
    """The CSS ``ease-in-out`` curve (slow start and end)."""
    LINEAR: ClassVar[Easing]
    """The CSS ``linear`` curve (constant rate)."""
    STEP_START: ClassVar[Easing]
    """The CSS ``step-start`` curve (jump to the end state immediately)."""
    STEP_END: ClassVar[Easing]
    """The CSS ``step-end`` curve (hold, then jump at the end)."""

    @classmethod
    def cubic_bezier(cls, x1: float, y1: float, x2: float, y2: float) -> Easing:
        """A custom cubic-bézier curve as an ``Easing`` (the CSS function string)."""
        return cls(f"cubic-bezier({x1}, {y1}, {x2}, {y2})")

    @classmethod
    def raw(cls, css: str) -> Easing:
        """Any CSS easing string verbatim, e.g. ``Easing.raw("steps(4, end)")``."""
        return cls(css)


Easing.EASE = Easing("ease")
Easing.EASE_IN = Easing("ease-in")
Easing.EASE_OUT = Easing("ease-out")
Easing.EASE_IN_OUT = Easing("ease-in-out")
Easing.LINEAR = Easing("linear")
Easing.STEP_START = Easing("step-start")
Easing.STEP_END = Easing("step-end")


class Trigger(str):
    """When a cue fires. You set the intent; step numbers are inferred.

    ```python
    FadeIn("headline")                          # on the next keypress
    FadeIn("subtitle", Trigger.WITH_PREVIOUS)   # with the previous cue
    FadeIn("arrow", Trigger.at(3))              # pinned to step 3
    ```

    Markdown reveals accept the same values via ``trigger=``
    (``::step trigger=with-previous::``, ``::step trigger=3::``).
    """

    ON_CLICK: ClassVar[Trigger]
    """The default: the cue fires on the next keypress."""
    WITH_PREVIOUS: ClassVar[Trigger]
    """Fire together with the previous cue. When it comes first, the element is
    visible from the start."""

    @classmethod
    def at(cls, step: int) -> Trigger:
        """Pin the cue to an absolute step number."""
        return cls(str(int(step)))

    @property
    def explicit_step(self) -> int | None:
        """The step for a `Trigger.at(...)` value, or ``None`` for a preset."""
        body = self[1:] if self.startswith("-") else self
        return int(self) if body.isdigit() else None


Trigger.ON_CLICK = Trigger("on-click")
Trigger.WITH_PREVIOUS = Trigger("with-previous")


class Muted(Enum):
    """Audio muting policy for a ``Video``.

    Unlike the other enums here this never becomes a CSS/HTML value; it is
    resolved in Python to *whether* the ``<video>`` gets a ``muted`` attribute,
    so it is a plain ``Enum``, not a ``_KebabStrEnum``.
    """

    AUTO = auto()
    """Muted **iff** the video autoplays. Sidesteps the browser's autoplay block
    by default while leaving gesture-triggered playback (``play_on_step``,
    ``controls``) audible."""
    ON = auto()
    """Always muted."""
    OFF = auto()
    """Always unmuted. Explicit opt-in: an autoplaying clip may be blocked by the
    browser on a cold load, which the author accepts."""
