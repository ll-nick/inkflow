from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import TypeAlias

from inkflow.animations import Cue
from inkflow.enums import (
    Align,
    ColorMode,
    MediaAlign,
    MediaFit,
    Muted,
    VAlign,
)
from inkflow.overlay import Overlay
from inkflow.themes import Builtin, Theme
from inkflow.transitions import Transition

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
    To start a clip on a step rather than on load, add an
    ``animations.PlayVideo`` cue for its zone.

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
    overlays: Sequence[Overlay] | None = None
    """Chrome composited on top of this slide, in paint order. ``None`` inherits the
    deck's overlays; ``[]`` opts this slide out of all chrome."""
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

    - ``transition``, ``font_size``, ``overlays`` — *override*: a slide value replaces
      the deck default; ``None`` on the slide inherits. If both are ``None``,
      the theme default is used.
    - ``style`` / ``extra_style`` — *additive*: ``Deck.style`` is emitted first,
      then ``Slide.extra_style``; the slide CSS wins on equal-specificity rules via
      cascade order.
    - ``theme``, ``mode``, ``embed_fonts``, ``title`` — deck-only; no per-slide
      override.

    ```python
    def main() -> Deck:
        return Deck(
            transition=transitions.Crossfade(),
            mode=ColorMode.DARK,
            slides=[...],
        )
    ```
    """

    slides: list[Slide] = field(default_factory=list)
    """The ordered slide list."""
    transition: Transition | None = None
    """Default transition for all slides. ``None`` defers to the theme's default."""
    overlays: Sequence[Overlay] | None = None
    """Chrome composited on top of every slide, in paint order. ``None`` defers to
    the theme's overlays; ``[]`` means none."""
    theme: Theme = field(default_factory=Builtin)
    """The deck's theme. Defaults to the built-in Catppuccin theme. Subclass
    ``Theme`` (or ``Builtin``) and pass an instance to restyle the deck."""
    mode: ColorMode | None = None
    """Dark or light color mode. ``None`` defers to the theme's ``mode``."""
    style: Content = None
    """CSS injected into every slide. A bare ``str`` is a file path; ``Inline(...)``
    is a literal CSS string."""
    font_size: int | None = None
    """Base font size for zone content, in px. ``None`` defers to the theme."""
    embed_fonts: bool = True
    """Auto-discover and embed the fonts used in slides. Set ``False`` to opt out."""
    title: str | None = None
    """Presentation title, used for the browser tab, static build page, and PDF
    metadata. ``None`` infers a title from the project directory name."""

    @property
    def effective_mode(self) -> ColorMode:
        """Resolved color mode: the deck value, else the theme's default."""
        return self.mode if self.mode is not None else self.theme.mode

    @property
    def effective_font_size(self) -> int:
        """Resolved base font size: the deck value, else the theme's default."""
        return self.font_size if self.font_size is not None else self.theme.font_size

    @property
    def effective_transition(self) -> Transition:
        """Resolved default transition: the deck value, else the theme's default."""
        return self.transition if self.transition is not None else self.theme.transition

    @property
    def effective_overlays(self) -> Sequence[Overlay]:
        """Resolved default overlays: the deck value, else the theme's."""
        return self.overlays if self.overlays is not None else self.theme.overlays
