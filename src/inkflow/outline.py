"""A structured description of a deck: what ``inkflow deck show`` prints.

Its JSON form is the machine-readable interface for tools and editors, versioned
as `API_VERSION`. Values are reported as the deck *wrote* them (``None``
where a slide inherits), so a consumer can tell an override from a default.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import asdict, dataclass, fields
from enum import StrEnum
from pathlib import Path
from typing import cast

from lxml import etree

from inkflow.animations import Cue
from inkflow.assets import AssetRoots, AssetSource
from inkflow.deck_source import Editability, SlideSource, locate_slides
from inkflow.enums import FrameTarget
from inkflow.layout import (
    SLIDE_NUMBER_ZONE_IDS,
    discover_layouts,
    resolve_chain,
    resolve_default_zone,
)
from inkflow.loaders import load_md, resolve_content_src
from inkflow.manifest import Content, Deck, Inline, Slide
from inkflow.overlay import Overlay
from inkflow.pipeline import (
    SlideSvg,
    infer_slide_title,
    resolve_overlay_chains,
    resolve_slide_src,
    slide_ids,
)
from inkflow.provenance import SourceLocation, source_location
from inkflow.sync import slide_overlays
from inkflow.titles import resolve_deck_title
from inkflow.transitions import Transition
from inkflow.zones import ParsedMarkdown, build_slide_content, parse_markdown_zones

__all__ = ["API_VERSION", "DeckOutline", "SlideOutline", "build_outline"]

API_VERSION = "v0"

_ZONE_PREFIX = "zone-"

JsonValue = str | int | float | bool | None


class ContentKind(StrEnum):
    FILE = "file"
    INLINE = "inline"


@dataclass(frozen=True)
class SourceSpan:
    """A `SourceLocation` with its path made relative to the project when inside it."""

    path: str
    line: int
    column: int | None
    """0-based UTF-8 byte offset, as Python's ``ast`` counts."""
    end_line: int | None
    end_column: int | None


@dataclass(frozen=True)
class ContentRef:
    """A ``Content`` field: a file (by path) or inline text."""

    kind: ContentKind
    path: str | None


@dataclass(frozen=True)
class ValueOutline:
    """A DSL value such as a transition, by Python type name and its set fields."""

    type: str
    fields: dict[str, JsonValue]


@dataclass(frozen=True)
class CueOutline:
    type: str
    element: str | None
    """Target element id; ``None`` for a `Frame` on the full slide."""
    trigger: str
    defined_at: SourceSpan | None


@dataclass(frozen=True)
class ZonesOutline:
    available: list[str]
    """Content zone names (without ``zone-``) in the composed slide, overlays
    included."""
    filled: list[str]
    """Zones that receive content from ``md`` or ``zones``."""
    default: str | None
    """Where unmarked Markdown goes; ``None`` when the slide has no default zone."""
    numbered: bool
    """Whether the slide shows its number or the deck's total; those zones are
    filled by the pipeline and not listed in ``available``."""


@dataclass(frozen=True)
class EditabilityOutline:
    level: Editability
    reason: str | None
    element: SourceSpan | None
    """The list element in ``deck.py`` the slide belongs to."""


@dataclass(frozen=True)
class SlideOutline:
    index: int
    """Position in ``Deck.slides``, hidden slides included (0-based)."""
    number: int | None
    """Presentation number (1-based); ``None`` for a hidden slide."""
    id: str | None
    """The presenter's id; for a hidden slide only an explicit ``id=``."""
    title: str
    visible: bool
    src: str
    path: str | None
    """The resolved SVG file; ``None`` when ``src`` does not resolve."""
    parents: list[str]
    """The ``inkflow:parent`` chain, nearest ancestor last."""
    md: ContentRef | None
    notes: ContentRef | None
    transition: ValueOutline | None
    overlays: list[str] | None
    zones: ZonesOutline | None
    """``None`` when the slide's SVG could not be composed (see ``errors``)."""
    cues: list[CueOutline]
    defined_at: SourceSpan | None
    editability: EditabilityOutline
    errors: list[str]


@dataclass(frozen=True)
class DeckOutline:
    api: str
    project_dir: str
    """Absolute; every other path is relative to it when inside it."""
    deck_file: str
    title: str
    theme: str
    mode: str
    transition: ValueOutline | None
    overlays: list[str] | None
    slides: list[SlideOutline]

    def to_json(self) -> dict[str, object]:
        return asdict(self)


def build_outline(deck: Deck, project_dir: Path, deck_path: Path) -> DeckOutline:
    project_dir = project_dir.resolve()
    deck_path = deck_path.resolve()
    visible = [slide for slide in deck.slides if slide.visible]
    presenter_ids = dict(zip(map(id, visible), slide_ids(visible), strict=True))
    sources = locate_slides(deck, deck_path)

    outliner = _SlideOutliner.create(deck, project_dir)
    slides: list[SlideOutline] = []
    number = 0
    for index, (slide, slide_source) in enumerate(
        zip(deck.slides, sources, strict=True)
    ):
        if slide.visible:
            number += 1
        slides.append(
            outliner.outline(
                slide,
                index,
                number if slide.visible else None,
                presenter_ids.get(id(slide), slide.id),
                slide_source,
            )
        )

    return DeckOutline(
        api=API_VERSION,
        project_dir=project_dir.as_posix(),
        deck_file=_display_path(deck_path, project_dir),
        title=resolve_deck_title(deck, project_dir),
        theme=deck.theme.name,
        mode=deck.effective_mode,
        transition=_value_outline(deck.transition),
        overlays=_overlay_srcs(deck.overlays),
        slides=slides,
    )


@dataclass(frozen=True)
class _SlideOutliner:
    deck: Deck
    project_dir: Path
    layout_references: dict[Path, str]
    """``builtin:content``-style names for layouts outside the project, so the
    outline names them as ``inkflow:parent`` would instead of by install path."""

    @classmethod
    def create(cls, deck: Deck, project_dir: Path) -> _SlideOutliner:
        references: dict[Path, str] = {}
        # discover_layouts lists builtin before theme, and the built-in theme's own
        # directory appears under both: the first name, `builtin:`, is the stable one.
        for source, path in discover_layouts(project_dir, deck.theme):
            if source != "local":
                references.setdefault(path.resolve(), f"{source}:{path.stem}")
        return cls(deck, project_dir, references)

    def _reference(self, path: Path) -> str:
        if path.is_relative_to(self.project_dir):
            return _display_path(path, self.project_dir)
        return self.layout_references.get(path.resolve(), path.as_posix())

    def outline(
        self,
        slide: Slide,
        index: int,
        number: int | None,
        slide_id: str | None,
        slide_source: SlideSource,
    ) -> SlideOutline:
        errors: list[str] = []
        parsed = self._parsed_markdown(slide, errors)
        path, parents, zones = self._composition(slide, parsed, errors)
        title = infer_slide_title(slide, slide_id or Path(slide.src).stem, parsed)
        return SlideOutline(
            index=index,
            number=number,
            id=slide_id,
            title=title,
            visible=slide.visible,
            src=slide.src,
            path=path,
            parents=parents,
            md=self._content_ref(slide.md, is_markdown=True),
            notes=self._content_ref(slide.notes, is_markdown=False),
            transition=_value_outline(slide.transition),
            overlays=_overlay_srcs(slide.overlays),
            zones=zones,
            cues=[self._cue_outline(cue) for cue in slide.animations],
            defined_at=self._span(source_location(slide)),
            editability=EditabilityOutline(
                level=slide_source.editability,
                reason=slide_source.reason,
                element=self._span(slide_source.element),
            ),
            errors=errors,
        )

    def _parsed_markdown(
        self, slide: Slide, errors: list[str]
    ) -> ParsedMarkdown | None:
        try:
            loaded = load_md(slide.md, self.project_dir)
        except OSError as exc:
            errors.append(f"markdown not readable: {exc}")
            return None
        return parse_markdown_zones(loaded.text) if loaded is not None else None

    def _composition(
        self, slide: Slide, parsed: ParsedMarkdown | None, errors: list[str]
    ) -> tuple[str | None, list[str], ZonesOutline | None]:
        theme = self.deck.theme
        try:
            src = resolve_slide_src(slide.src, self.project_dir, theme)
        except ValueError as exc:
            errors.append(str(exc))
            return None, [], None
        path = self._reference(src)
        if not src.exists():
            errors.append(f"source not found: {path}")
            return path, [], None
        try:
            chain = resolve_chain(src, self.project_dir, theme)
            overlay_chains = resolve_overlay_chains(
                slide_overlays(slide, self.deck), self.project_dir, theme
            )
            roots = AssetRoots(self.project_dir, theme.asset_dir())
            doc = SlideSvg.read(src, roots)
            doc.compose_ancestors(chain, roots)
            doc.compose_overlays(overlay_chains, roots)
        except (ValueError, OSError, etree.LxmlError) as exc:
            errors.append(f"could not compose SVG: {exc}")
            return path, [], None

        parents = [self._reference(parent) for parent in chain]
        zone_ids = doc.zone_ids()
        default_zone = resolve_default_zone(doc.root, zone_ids)
        # Only the zone structure matters here, so references resolve against the
        # plain project roots: nothing reported depends on where an asset points.
        plain_source = AssetSource.for_deck(AssetRoots(self.project_dir))
        try:
            filled = build_slide_content(
                parsed,
                slide.zones,
                plain_source,
                plain_source,
                available_zones=zone_ids,
                default_zone=default_zone,
            ).content
        except ValueError as exc:
            errors.append(f"could not route zone content: {exc}")
            filled = {}
        zones = ZonesOutline(
            available=_zone_names(zone_ids),
            filled=_zone_names(filled.keys()),
            default=default_zone or None,
            numbered=bool(zone_ids & SLIDE_NUMBER_ZONE_IDS),
        )
        return path, parents, zones

    def _content_ref(self, content: Content, *, is_markdown: bool) -> ContentRef | None:
        if content is None:
            return None
        if isinstance(content, Inline):
            return ContentRef(ContentKind.INLINE, None)
        if is_markdown:
            resolved = resolve_content_src(content, self.project_dir)
        else:
            resolved = Path(content)
            if not resolved.is_absolute():
                resolved = self.project_dir / resolved
        return ContentRef(ContentKind.FILE, _display_path(resolved, self.project_dir))

    def _cue_outline(self, cue: Cue) -> CueOutline:
        return CueOutline(
            type=type(cue).__name__,
            element=None if cue.element == FrameTarget.FULL_SLIDE else cue.element,
            trigger=str(cue.trigger),
            defined_at=self._span(source_location(cue)),
        )

    def _span(self, location: SourceLocation | None) -> SourceSpan | None:
        if location is None:
            return None
        return SourceSpan(
            path=_display_path(location.path, self.project_dir),
            line=location.line,
            column=location.column,
            end_line=location.end_line,
            end_column=location.end_column,
        )


def _display_path(path: Path, project_dir: Path) -> str:
    if path.is_relative_to(project_dir):
        return path.relative_to(project_dir).as_posix()
    return path.as_posix()


def _zone_names(zone_ids: Iterable[str]) -> list[str]:
    return sorted(
        zone_id.removeprefix(_ZONE_PREFIX)
        for zone_id in zone_ids
        if zone_id not in SLIDE_NUMBER_ZONE_IDS
    )


def _overlay_srcs(overlays: Sequence[Overlay] | None) -> list[str] | None:
    return None if overlays is None else [overlay.src for overlay in overlays]


def _value_outline(value: Transition | None) -> ValueOutline | None:
    if value is None:
        return None
    set_fields: dict[str, JsonValue] = {}
    for field in fields(value):
        field_value = cast("object", getattr(value, field.name))
        if field_value is None:
            continue
        set_fields[field.name] = (
            field_value
            if isinstance(field_value, str | int | float | bool)
            else str(field_value)
        )
    return ValueOutline(type=type(value).__name__, fields=set_fields)
