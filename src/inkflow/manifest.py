from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TypeAlias

from inkflow.enums import (
    Align,
    ColorMode,
    Easing,
    MediaAlign,
    MediaFit,
    Muted,
    Trigger,
    VAlign,
)

# ── Type-name slug ────────────────────────────────────────────────────────────


def camel_to_kebab(name: str) -> str:
    """`FadeIn` -> `fade-in`, `SlideIn` -> `slide-in`, `Highlight` -> `highlight`."""
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower()


class _Slugged:
    """Mixin giving a DSL type a kebab-case slug derived from its class name."""

    @classmethod
    def slug(cls) -> str:
        return camel_to_kebab(cls.__name__)


# ── Content marker ────────────────────────────────────────────────────────────


class Inline(str):
    """Marks a string as literal content rather than a file path.

    Fields typed as ``Content`` interpret a bare ``str`` as a file path to read.
    Wrapping the value in ``Inline(...)`` signals that the string itself is the
    content — rendered as Markdown for ``notes``/``md``, or used as CSS for
    ``style``/``extra_style``.

    ``Inline`` subclasses ``str``, so ``isinstance(Inline("x"), str)`` is ``True``
    and it compares equal to its content. The distinction only matters at pipeline
    resolution time.

    ```python
    Slide("content", notes=Inline("Talk through the diagram."))
    Slide("content", md=Inline("# Quick slide\\n\\nNo .md file needed."))
    Deck(style=Inline("rect { fill: red; }"))
    ```
    """


Content: TypeAlias = "str | Inline | None"
"""A field that accepts either a file path or literal content.

A bare ``str`` is treated as a path to read; an ``Inline`` value is used
verbatim. ``None`` means "nothing". Used by ``Slide.md``, ``Slide.notes``,
``Slide.extra_style``, and ``Deck.style``.
"""

# ── Animation ────────────────────────────────────────────────────────────────


@dataclass
class Cue:
    """Base for anything on a slide's step timeline."""

    element: str
    """Id of the target element, e.g. ``"headline"``."""
    trigger: Trigger = Trigger.ON_CLICK
    """When the cue fires. Defaults to `Trigger.ON_CLICK`."""


@dataclass
class Animation(Cue, _Slugged):
    """Base for every animation type.

    Concrete types live in ``inkflow.animations`` and subclass this, adding their
    own fields. ``duration``, ``easing``, and ``delay`` are shared keyword-only
    timing params.

    **Custom animations.** Subclass this directly in ``deck.py`` — no changes to
    inkflow are needed. The CSS class is the kebab-cased type name (``MyGlow`` →
    ``anim-my-glow``), and each extra field becomes a ``--anim-<field>`` custom
    property on the element. Put the matching CSS in a ``styles.css`` next to
    ``deck.py`` (loaded automatically).

    ```python
    @dataclass
    class MyGlow(Animation):
        intensity: float = 1.0   # → --anim-intensity on the element
    ```
    """

    duration: float = field(default=0.4, kw_only=True)
    """Duration in seconds."""
    easing: Easing = field(default=Easing.EASE, kw_only=True)
    """Easing curve — an ``Easing`` preset (e.g. ``Easing.EASE_IN_OUT``) or a
    custom curve via ``Easing.cubic_bezier(...)``."""
    delay: float = field(default=0.0, kw_only=True)
    """Seconds to wait before the animation starts."""


# ── Transition ────────────────────────────────────────────────────────────────


@dataclass
class Transition(_Slugged):
    """Data-only base for every transition type.

    Concrete types live in ``inkflow.transitions`` and subclass this. Every field
    is serialized into the transition JSON, so ``direction``, ``color`` etc. arrive
    on the JS ``TransitionData`` object automatically.

    **Custom transitions.** Subclass this in ``deck.py``; the type name becomes the
    JS handler key via ``camel_to_kebab`` (``MyWarp`` → ``"my-warp"``). Register
    the matching handler from a ``scripts.js`` next to ``deck.py`` with
    ``window.inkflow.registerProgressTransition(name, render)`` (or the
    lower-level ``registerTransition``).
    """

    duration: float = 0.5
    """Duration in seconds. Defaults to ``0.5``; ``Cut`` overrides it to ``0.0``."""
    easing: Easing = field(default=Easing.EASE, kw_only=True)
    """Easing curve — an ``Easing`` preset or a custom curve via
    ``Easing.cubic_bezier(...)``."""


# ── Content types ─────────────────────────────────────────────────────────────


@dataclass
class TextBox:
    """Explicit text content and alignment for a named zone in an SVG slide.

    Pass it as a value in a slide's ``zones`` dict to inject HTML into that zone
    with alignment control. Each alignment param defaults to ``None``, meaning
    "defer to the layout's CSS variable".

    ```python
    TextBox(text="<p>My content</p>", align=Align.CENTER, valign=VAlign.CENTER)
    ```
    """

    text: str | None = None
    """HTML content to inject into the zone."""
    align: Align | None = None
    """Horizontal text alignment. ``None`` defers to the layout CSS variable."""
    valign: VAlign | None = None
    """Vertical alignment of the content block. ``None`` defers to the CSS variable."""
    padding: float | None = None
    """Inner padding in SVG user units. ``None`` defers to the CSS variable."""


@dataclass
class _MediaBase:
    """Shared geometry/placement fields for `Image` and `Video`.

    Private: this exists only so the two concrete media types don't repeat the
    same fields. It is never used for dispatch (that goes through the ``Media``
    union + ``isinstance``) and is not part of the public API.
    """

    src: str
    """Path to a media file, or a URL."""
    alt_src: str | None = None
    """Alternative source used in the other color mode."""
    fit: MediaFit = MediaFit.CONTAIN
    """CSS ``object-fit`` value."""
    align: MediaAlign = MediaAlign.CENTER
    """CSS ``object-position`` preset (spatial crop/anchor)."""
    x: float = 0.0
    """Horizontal offset in pixels."""
    y: float = 0.0
    """Vertical offset in pixels."""


@dataclass
class Image(_MediaBase):
    """An image asset for injection into a zone.

    Pass it as a value in a slide's ``zones`` dict to inject it into that zone.

    ```python
    Slide("default", md="bullets", zones={"media": Image("photo.jpg")})
    ```
    """


@dataclass
class Video(_MediaBase):
    """A video asset for injection into a zone, with playback control.

    Pass it as a value in a slide's ``zones`` dict to inject it into that zone.
    Playback is driven by the presenter, so ``play_on_step`` ties a clip into the
    slide's step sequence exactly like any other stepped element.

    ```python
    Slide(
        "media-right",
        md="feature",
        zones={"media": Video("demo.mp4", autoplay=True, loop=True)},
    )
    ```
    """

    controls: bool = True
    """Show the browser's native playback controls."""
    autoplay: bool = False
    """Start playing when the slide loads."""
    muted: Muted = Muted.AUTO
    """Audio muting policy. ``AUTO`` mutes only when ``autoplay`` is set, so the
    browser never blocks autoplay by default; ``ON`` always mutes; ``OFF`` never
    mutes."""
    loop: bool = False
    """Restart from ``start`` when the clip ends."""
    poster: str | None = None
    """Path/URL of a still image shown before playback begins."""
    start: float | None = None
    """Trim-in time in seconds (temporal trim, distinct from the spatial
    ``fit``/``align`` crop)."""
    end: float | None = None
    """Trim-out time in seconds."""
    play_on_step: int | None = None
    """Step at which the clip starts playing. Active when
    ``play_on_step <= current_step``; stepping back below it resets to ``start``.
    ``None`` means playback is governed by ``autoplay``/``controls`` alone."""


Media = Image | Video
"""A media asset of either kind — the union of `Image` and `Video`."""


ZoneContent = str | Media | TextBox
"""A value accepted in ``Slide.zones``.

A ``str`` is rendered as inline Markdown; a ``TextBox`` gives explicit
alignment and padding control; an ``Image`` or ``Video`` injects media.
"""


# ── Slide / Deck ──────────────────────────────────────────────────────────────


@dataclass
class Slide:
    """A single slide.

    ``src`` is a reference to an SVG file. Any SVG can define named zones, and
    if it does, ``md``/``zones`` inject content into them — whether that SVG is
    a one-off slide in ``slides/`` or a reusable layout in ``layouts/`` shared
    across many slides.

    Markdown content can link to another slide by id with the ``slide:`` scheme
    (``[overview](slide:overview)``); clicking it jumps to that slide with a cut
    transition. Unresolved ids are silently ignored.

    ```python
    # One-off SVG with animations, no zones
    Slide("title", animations=[animations.FadeIn("headline")])

    # Reusable layout with Markdown-filled zones
    Slide("default", md="bullets", zones={"media": Image("photo.jpg")})
    ```
    """

    src: str
    """Reference to the slide's SVG file. A bare name (e.g. ``"default"``) is
    looked up in ``slides/`` first, then searched across layouts (project →
    theme → built-in); prefix with ``local:``, ``theme:``, or ``builtin:`` to
    pin to one of those directly."""
    id: str | None = None
    """Stable identifier, used as the ``slide:`` link target. Auto-inferred from the
    ``.md`` filename stem or the ``src`` stem when unset. Must be unique across the
    deck; collisions are resolved by appending ``-2``, ``-3``, …"""
    md: Content = None
    """Path to a ``.md`` file, or ``Inline("...")`` for inline Markdown. Content is
    routed into ``src``'s zones, if it defines any."""
    zones: dict[str, ZoneContent] = field(default_factory=dict)
    """Per-zone overrides. Keys are zone names without the ``zone-`` prefix; values
    are ``ZoneContent`` (inline Markdown ``str``, ``TextBox``, or
    ``Media``)."""
    animations: list[Cue] = field(default_factory=list)
    """Animations and `PlayVideo` cues for this slide. They run after any markdown
    reveals in the content."""
    transition: Transition | None = None
    """Transition into this slide. ``None`` inherits the deck default."""
    extra_style: Content = None
    """CSS appended to the deck style for this slide. A bare ``str`` is a file path;
    ``Inline(...)`` is a literal CSS string."""
    title: str | None = None
    """Optional slide title. Auto-inferred from the filename or a leading
    ``# heading`` when unset."""
    notes: Content = None
    """Speaker notes rendered as Markdown. A bare ``str`` is a file path;
    ``Inline("...")`` is literal content. Concatenated with any ``::notes::`` marker
    in the Markdown file."""
    visible: bool = True
    """When ``False``, the slide is excluded from the presentation entirely."""
    font_size: int | None = None
    """Per-slide base font size in px. ``None`` inherits ``Deck.font_size``."""


@dataclass
class Deck:
    """The top-level presentation container.

    Define a ``main() -> Deck`` function in ``deck.py``; inkflow calls it at serve
    time.

    **Deck → Slide inheritance:**

    - ``transition``, ``font_size`` — *override*: a slide value replaces the deck
      default; ``None`` on the slide inherits.
    - ``style`` / ``extra_style`` — *additive*: ``Deck.style`` is emitted first,
      then ``Slide.extra_style``; the slide CSS wins on equal-specificity rules via
      cascade order.
    - ``theme``, ``mode``, ``embed_fonts``, ``title`` — deck-only; no per-slide
      override.

    ```python
    def main() -> Deck:
        return Deck(
            transition=transitions.Crossfade(),
            theme="./my-theme",
            mode=ColorMode.DARK,
            slides=[...],
        )
    ```
    """

    slides: list[Slide] = field(default_factory=list)
    """The ordered slide list."""
    transition: Transition | None = None
    """Default transition for all slides. A ``Cut`` (instant) is used when unset."""
    theme: str | None = None
    """Path to a theme directory. ``None`` uses the built-in theme."""
    mode: ColorMode = ColorMode.DARK
    """Dark or light color mode for the presentation."""
    style: Content = None
    """CSS injected into every slide. A bare ``str`` is a file path; ``Inline(...)``
    is a literal CSS string."""
    font_size: int = 36
    """Base font size for zone content, in px."""
    embed_fonts: bool = True
    """Auto-discover and embed the fonts used in slides. Set ``False`` to opt out."""
    title: str | None = None
    """Presentation title, used for the browser tab, static build page, and PDF
    metadata. ``None`` infers a title from the project directory name."""
