from __future__ import annotations

from collections.abc import Sequence
from dataclasses import InitVar, dataclass, field
from typing import TypeAlias, cast, overload

from inkflow.animations import Cue
from inkflow.backgrounds import background_paint
from inkflow.enums import (
    Align,
    ChartKind,
    ColorMode,
    MediaAlign,
    MediaFit,
    Muted,
    VAlign,
)
from inkflow.overlay import Overlay
from inkflow.sizes import PageSize
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
    Slide("content", md="bullets", zones={"media": Image("photo.jpg")})
    ```

    A PDF (a figure from a paper) shows as vector graphics: its first page, or
    the page its fragment names, ``Image("figures/plot.pdf#page=2")``.
    ``page=2`` says the same and is kept as that fragment.
    """

    page: InitVar[int | None] = None
    """For a PDF, the page to show; stored in ``src`` as ``#page=N``."""
    background: str | None = None
    """Painted behind the picture, with a small margin, so a figure with a
    transparent background stays legible on any slide: ``"paper"`` (white,
    whatever the deck's mode: for figures drawn for paper on a dark deck),
    ``"surface"`` (the theme's), a theme colour name (``"blue"``) or ``#rrggbb``."""

    def __post_init__(self, page: int | None) -> None:
        if self.background is not None:
            background_paint(self.background)  # a clear error for a bad value
        if page is None:
            return
        if page < 1:
            raise ValueError(f"Image page must be 1 or more, not {page}")
        if "#" in self.src:
            raise ValueError(f"Image {self.src!r}: give the page in src or page=")
        if page > 1:
            self.src: str = f"{self.src}#page={page}"


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


ChartValue: TypeAlias = float | int | str | None
"""One cell of a chart's table: a number, a label, or ``None`` for a gap."""


@dataclass
class Chart:
    """A chart plotted from a table of data, drawn into a zone at build time.

    The data is a CSV, TSV or JSON file (``src``, relative to ``deck.py`` like an
    ``Image``), or the columns written inline (``data``). The first row of a CSV
    or TSV names the columns. ``x`` is the column of categories (default: the
    first column) and ``y`` the columns plotted against it (default: every other
    column holding numbers).

    Colours and text come from the theme, so a chart follows the deck's palette
    and colour mode. Every series is a group with the id
    ``<zone>-series-<column>`` (a pie's slices ``<zone>-slice-<category>``), so
    ``animations=[FadeIn("sales-series-revenue")]`` reveals one at a time.

    ```python
    Slide("content", zones={"sales": Chart("data/sales.csv", y=["revenue", "cost"])})
    Chart(data={"year": [2023, 2024], "users": [120, 180]}, kind=ChartKind.LINE)
    ```
    """

    src: str | None = None
    """Path to a ``.csv``, ``.tsv`` or ``.json`` file. Exactly one of ``src`` and
    ``data`` is given."""
    kind: ChartKind = ChartKind.BAR
    """Bars, lines, areas, dots or a pie (a plain string such as ``"line"`` works
    too)."""
    x: str | None = None
    """The column of categories (for a scatter, of x values). ``None``: the first."""
    y: list[str] | None = None
    """The columns plotted, one series each. ``None``: every other numeric column.
    A single name may be given as a plain string."""
    title: str | None = None
    """A heading drawn above the plot."""
    stacked: bool = False
    """Pile the series on each other (bar and area)."""
    horizontal: bool = False
    """Bars along the y axis, categories top to bottom (bar only)."""
    legend: bool | None = None
    """Show the legend. ``None``: when there is more than one series (always for
    a pie)."""
    labels: bool = False
    """Write each value at its bar, point or slice."""
    donut: bool = False
    """Cut the middle out of a pie."""
    y_min: float | None = None
    """Where the value axis starts. ``None``: from the data (bars and areas
    from zero). Values beyond ``y_min``/``y_max`` are cut off at the plot."""
    y_max: float | None = None
    """Where the value axis ends. ``None``: from the data."""
    y2: list[str] | None = None
    """Columns drawn against a second value axis on the right, with a scale of
    their own (a rate next to totals, say); plotted even when ``y`` leaves
    them out, and marked "(right)" in the legend. Bars (side by side), lines,
    areas and scatter; not with stacked or horizontal bars."""
    y2_min: float | None = None
    """Where the right axis starts. ``None``: from its data."""
    y2_max: float | None = None
    """Where the right axis ends. ``None``: from its data."""
    data: dict[str, list[ChartValue]] | None = None
    """The columns inline, ``{column: [values]}``, instead of a file."""

    def __post_init__(self) -> None:
        if (self.src is None) == (self.data is None):
            raise ValueError("Chart needs exactly one of src= (a file) or data=")
        self.kind = ChartKind(self.kind)
        if isinstance(self.y, str):
            self.y = [self.y]
        if isinstance(self.y2, str):
            self.y2 = [self.y2]
        for lo, hi, name in (
            (self.y_min, self.y_max, "y"),
            (self.y2_min, self.y2_max, "y2"),
        ):
            if lo is not None and hi is not None and lo >= hi:
                raise ValueError(f"Chart {name}_min must be below {name}_max")


ZoneContent = str | Media | TextBox | Chart
"""A value accepted in ``Slide.zones``.

A ``str`` is rendered as inline Markdown; a ``TextBox`` gives explicit
alignment and padding control; an ``Image`` or ``Video`` injects media; a
``Chart`` plots data.
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
    Slide("content", md="bullets", zones={"media": Image("photo.jpg")})
    ```
    """

    src: str
    """Reference to the slide's SVG file. A bare name (e.g. ``"content"``) is
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
    are ``ZoneContent`` (inline Markdown ``str``, ``TextBox``, ``Media`` or
    ``Chart``)."""
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
    ink: str | None = None
    """The SVG file holding this slide's saved pen drawing (ink), painted on top of
    everything else, overlays included. A path relative to the project. ``None``
    uses ``ink/<slide id>.svg``; a missing file means the slide has no ink."""


@dataclass
class Section:
    """A named group of consecutive slides, like PowerPoint's sections.

    Written in ``Deck(slides=[...])`` in place of the slides it holds; the
    deck flattens it, so ``Deck.slides`` stays the plain slide list and
    ``Deck.sections`` records each section. Slides written before the first
    section belong to none. A section may be empty; hidden slides keep theirs.

    ```python
    Deck(
        slides=[
            Slide("title"),
            Section("Method", slides=[Slide("setup"), Slide("data")]),
            Section("Results", slides=[Slide("plots")]),
        ],
    )
    ```
    """

    name: str
    """Shown above the section's slides in the editor and the overview, and in
    the presenter panel; two sections may share a name."""
    slides: list[Slide] = field(default_factory=list)
    """The section's slides, in order."""

    def __post_init__(self) -> None:
        name = cast("object", self.name)
        if not isinstance(name, str) or not name.strip():
            raise ValueError("a Section needs a name")
        for slide in cast("list[object]", self.slides):
            if not isinstance(slide, Slide):
                raise TypeError(
                    f"Section {self.name!r} holds {type(slide).__name__}, "
                    + "not Slide (sections do not nest)"
                )


class _SlideList:
    """``Deck.slides``: takes slides and sections, keeps the flat slide list.

    A data descriptor, so ``Deck(slides=[Slide(...), Section(...)])`` is
    accepted (and typed) while everything reading ``deck.slides`` keeps getting
    ``list[Slide]``; the sections are recorded beside it (``Deck.sections``).
    """

    @overload
    def __get__(self, obj: None, owner: type | None = None) -> tuple[()]: ...
    @overload
    def __get__(self, obj: Deck, owner: type | None = None) -> list[Slide]: ...
    def __get__(
        self, obj: Deck | None, owner: type | None = None
    ) -> list[Slide] | tuple[()]:
        if obj is None:
            return ()  # the dataclass default: no slides
        return obj._slides  # pyright: ignore[reportPrivateUsage]

    def __set__(self, obj: Deck, value: Sequence[Slide | Section]) -> None:
        flat: list[Slide] = []
        sections: list[Section] = []
        prefix = 0
        for item in cast("Sequence[object]", value):
            if isinstance(item, Section):
                sections.append(item)
                flat.extend(item.slides)
            elif isinstance(item, Slide):
                if sections:
                    raise ValueError(
                        f"Slide({item.src!r}) follows Section({sections[-1].name!r}) "
                        + "outside it: after the first section, every slide "
                        + "belongs in one"
                    )
                flat.append(item)
                prefix += 1
            else:
                raise TypeError(
                    f"Deck slides hold Slide and Section, not {type(item).__name__}"
                )
        obj._slides = flat  # pyright: ignore[reportPrivateUsage]
        obj._sections = sections  # pyright: ignore[reportPrivateUsage]
        obj._unsectioned = prefix  # pyright: ignore[reportPrivateUsage]


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
    - ``theme``, ``mode``, ``size``, ``embed_fonts``, ``title`` — deck-only; no
      per-slide override.

    ```python
    def main() -> Deck:
        return Deck(
            transition=transitions.Crossfade(),
            mode=ColorMode.DARK,
            slides=[...],
        )
    ```
    """

    slides: _SlideList = _SlideList()
    """The ordered slide list: ``Slide`` entries, then any ``Section`` groups
    of them. Read back, it is the flat ``list[Slide]`` (sections expanded in
    place); ``sections`` records the groups."""
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
    size: str | None = None
    """The deck's size: the canvas new slides are drawn on and the page a PDF
    prints at. A `PageSize` or its name: ``"16:9"``, ``"4:3"``, ``"9:16"``,
    ``"a0"`` … ``"a5"`` (``"a1-landscape"``), ``"letter"``, or a custom
    ``PageSize.mm(600, 900)``. ``None`` keeps each slide's own size and draws
    new slides at 16:9. A paper size (a poster) also gets a print type scale
    and, unless ``mode`` says otherwise, the light colour mode."""

    def __post_init__(self) -> None:
        if self.size is not None:
            self.size = PageSize(self.size)

    @property
    def effective_size(self) -> PageSize:
        """The deck's size, else 16:9 (what new slides are drawn at)."""
        return PageSize(self.size) if self.size is not None else PageSize.WIDESCREEN

    @property
    def is_print(self) -> bool:
        """Whether the deck is a sheet of paper (a poster, a handout)."""
        return self.size is not None and PageSize(self.size).is_print

    _slides: list[Slide] = field(init=False, repr=False, compare=False)
    _sections: list[Section] = field(init=False, repr=False, compare=False)
    _unsectioned: int = field(init=False, repr=False, compare=False)

    @property
    def sections(self) -> list[Section]:
        """The sections, in order (empty when the deck has none)."""
        return self._sections

    def section_ranges(self) -> list[range]:
        """Each section's slides as indices into ``slides``, in order."""
        ranges: list[range] = []
        start = self._unsectioned
        for section in self._sections:
            ranges.append(range(start, start + len(section.slides)))
            start += len(section.slides)
        return ranges

    def section_of(self, index: int) -> int | None:
        """The section slide ``index`` belongs to (``None``: before them all)."""
        for k, span in enumerate(self.section_ranges()):
            if index in span:
                return k
        return None

    @property
    def effective_mode(self) -> ColorMode:
        """Resolved color mode: the deck value, else the theme's default. A print
        deck is light unless its theme sets a mode of its own."""
        if self.mode is not None:
            return self.mode
        if self.is_print and not _sets_mode(self.theme):
            return ColorMode.LIGHT
        return self.theme.mode

    @property
    def effective_font_size(self) -> int:
        """Resolved base font size: the deck value, else the theme's default,
        scaled to the deck's size (`PageSize.base_font`)."""
        if self.font_size is not None:
            return self.font_size
        return self.effective_size.base_font(self.theme.font_size)

    @property
    def effective_transition(self) -> Transition:
        """Resolved default transition: the deck value, else the theme's default."""
        return self.transition if self.transition is not None else self.theme.transition

    @property
    def effective_overlays(self) -> Sequence[Overlay]:
        """Resolved default overlays: the deck value, else the theme's."""
        return self.overlays if self.overlays is not None else self.theme.overlays


def _sets_mode(theme: Theme) -> bool:
    """Whether a theme chose its colour mode, rather than inheriting the base
    class's default."""
    if "mode" in vars(theme):
        return True
    return any("mode" in vars(c) for c in type(theme).__mro__ if c is not Theme)
