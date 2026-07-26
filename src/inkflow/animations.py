"""Built-in animation types for the deck DSL.

The base `Animation` (element + trigger from `Cue`, plus ``duration``/``easing``/
``delay``) lives here alongside the three semantic bases `Enter`, `Exit`, and
`Emphasis`, which fix the animation's `AnimationKind`. Concrete types are thin
subclasses of those bases, adding only their own fields. This namespace also holds
`PlayVideo`, the non-animating video cue that shares the same step timeline.

How a type maps to CSS:

- The step engine drives each cue via the Web Animations API, reading the
  ``@keyframes anim-<slug>`` rule whose slug is the kebab-cased class name
  (``Animation.slug()``): ``FadeIn`` → ``anim-fade-in``, ``SlideIn`` →
  ``anim-slide-in``, ``Highlight`` → ``anim-highlight``. Defining a new type is
  "add a subclass here + write a matching ``@keyframes`` rule," nothing else.
- Every field becomes part of the cue's serialized params. Timing fields
  (``duration``/``easing``/``delay``) drive the ``element.animate()`` options; the
  rest are substituted into the keyframes wherever they appear as a
  ``var(--anim-<field>)`` token (e.g. ``var(--anim-distance)``), leaving other custom
  properties like ``var(--accent)`` for the browser to resolve.
- ``kind`` decides how several cues on one element compose: enters reveal, exits hide,
  emphasis fires momentarily without changing visibility.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import ClassVar

from inkflow.enums import AnimationKind, Direction, Easing
from inkflow.manifest import Cue, Slugged

__all__ = [
    "Animation",
    "Bounce",
    "Emphasis",
    "Enter",
    "Exit",
    "FadeIn",
    "FadeOut",
    "Highlight",
    "PlayVideo",
    "SlideIn",
    "SlideOut",
    "ZoomIn",
    "ZoomOut",
]


# ── Base + semantic bases ──────────────────────────────────────────────────────


@dataclass
class Animation(Cue, Slugged):
    """Base for every animation type.

    Concrete types subclass one of `Enter` / `Exit` / `Emphasis` (which fix the
    `AnimationKind`), adding their own fields. ``element``/``trigger`` come from `Cue`;
    ``duration``, ``easing``, and ``delay`` are shared keyword-only timing params.

    **Custom animations.** Subclass a semantic base in ``deck.py`` — no changes to
    inkflow are needed. Write a matching ``@keyframes`` rule named after the kebab-cased
    type (``MyGlow`` → ``@keyframes anim-my-glow``) in a ``styles.css`` next to
    ``deck.py`` (loaded automatically). Any extra field is substituted into the
    keyframes wherever it appears as ``var(--anim-<field>)``.

    ```python
    from inkflow import animations

    @dataclass
    class MyGlow(animations.Emphasis):
        intensity: float = 1.0   # → var(--anim-intensity) in @keyframes anim-my-glow
    ```
    """

    kind: ClassVar[AnimationKind] = AnimationKind.ENTER
    """The animation's lifecycle role. Overridden by the semantic base classes; a bare
    ``Animation`` subclass defaults to an enter."""
    duration: float = field(default=0.4, kw_only=True)
    """Duration in seconds."""
    easing: Easing = field(default=Easing.EASE, kw_only=True)
    """Easing curve — an ``Easing`` preset (e.g. ``Easing.EASE_IN_OUT``) or a
    custom curve via ``Easing.cubic_bezier(...)``."""
    delay: float = field(default=0.0, kw_only=True)
    """Seconds to wait before the animation starts."""


class Enter(Animation):
    """Base for animations that reveal an element (hidden until their step)."""

    kind: ClassVar[AnimationKind] = AnimationKind.ENTER


class Exit(Animation):
    """Base for animations that hide an element (shown until their step)."""

    kind: ClassVar[AnimationKind] = AnimationKind.EXIT


class Emphasis(Animation):
    """Base for momentary accents that leave the element's visibility unchanged."""

    kind: ClassVar[AnimationKind] = AnimationKind.EMPHASIS


# ── Video cue ──────────────────────────────────────────────────────────────────


@dataclass
class PlayVideo(Cue):
    """Start a video on a step instead of on load.

    ``element`` is the *zone key* of a `Video`, e.g. ``"media"`` for
    ``zones={"media": Video(...)}``. At its step the clip plays; stepping back
    resets it.

    ```python
    Slide(
        "media",
        zones={"media": Video("demo.mp4")},
        animations=[animations.PlayVideo("media")],
    )
    ```

    If the video also sets ``autoplay=True``, the cue wins and autoplay is dropped.
    """


# ── Enter animations ───────────────────────────────────────────────────────────


@dataclass
class FadeIn(Enter):
    """Element starts hidden, fades in on its step."""


@dataclass
class Bounce(Enter):
    """Element starts hidden just below its place and springs up into it on its step."""

    duration: float = field(default=0.35, kw_only=True)
    """Duration in seconds."""
    easing: Easing = field(
        default=Easing.cubic_bezier(0.34, 1.56, 0.64, 1), kw_only=True
    )
    """Easing curve — defaults to a spring that overshoots past the resting position
    and settles back, which is what gives the bounce its character."""
    distance: float = 14.0
    """How far below its resting place the element starts, in SVG user units."""


@dataclass
class SlideIn(Enter):
    """Element slides in from an edge, fading as it arrives."""

    direction: Direction = Direction.LEFT
    """Edge the element slides in from."""
    distance: float = 60.0
    """Travel distance in SVG user units."""


@dataclass
class ZoomIn(Enter):
    """Element scales up into place from ``scale``."""

    scale: float = 0.8
    """Starting scale, e.g. ``0.6``."""


# ── Exit animations ────────────────────────────────────────────────────────────


@dataclass
class FadeOut(Exit):
    """Element starts visible, fades out on its step."""


@dataclass
class SlideOut(Exit):
    """Element slides out toward an edge, fading as it leaves."""

    direction: Direction = Direction.LEFT
    """Edge the element slides out toward."""
    distance: float = 60.0
    """Travel distance in SVG user units."""


@dataclass
class ZoomOut(Exit):
    """Element scales down out of place toward ``scale``."""

    scale: float = 0.8
    """Ending scale."""


# ── Emphasis animations ────────────────────────────────────────────────────────


@dataclass
class Highlight(Emphasis):
    """Pulse the element ``passes`` times without hiding it."""

    duration: float = field(default=0.6, kw_only=True)
    """Duration of one pulse in seconds."""
    color: str = "var(--accent)"
    """Glow color (any CSS color or theme token)."""
    passes: int = 1
    """Number of pulses."""
