"""Shared enum types used across the deck DSL.

These aren't specific to any one module — ``Direction`` is used by both
animations and transitions, ``Align``/``VAlign`` by text zones, ``MediaFit``/
``MediaAlign`` by ``Media``, and ``ColorMode`` by ``Deck``.
"""

from __future__ import annotations

from enum import Enum, StrEnum, auto

__all__ = [
    "Align",
    "ColorMode",
    "Direction",
    "MediaAlign",
    "MediaFit",
    "Muted",
    "VAlign",
]


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
    presenter and the ``anim-from-*`` modifier class suffix.
    """

    LEFT = auto()
    """Leftward."""
    RIGHT = auto()
    """Rightward."""
    UP = auto()
    """Upward."""
    DOWN = auto()
    """Downward."""


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
