from __future__ import annotations

import json
import re
import site
import sysconfig
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from functools import cache
from pathlib import Path
from typing import NamedTuple, NotRequired, TypedDict, cast

from inkflow import ns
from inkflow.animations import Animation, Cue, PlayVideo
from inkflow.assets import AssetRoots, AssetSource, read_resolved_svg
from inkflow.backgrounds import picture_backgrounds
from inkflow.charts import ZONE_TEXT_SCALE, fence_font
from inkflow.content import (
    inject_style,
    remove_unreferenced_zones,
    substitute_content,
    substitute_zone_numbers,
    unreferenced_zones,
    zone_box,
)
from inkflow.drawio_inline import inline_diagrams
from inkflow.editor.provenance import INK, stamper
from inkflow.enums import AnimationKind, ColorMode, Direction, Trigger
from inkflow.ink import compose_ink, ink_path
from inkflow.layout import (
    AssetKind,
    resolve_chain,
    resolve_default_zone,
    resolve_parent_path,
)
from inkflow.loaders import LoadedText, load_md, load_notes, load_style
from inkflow.logging import logger
from inkflow.manifest import (
    Deck,
    Inline,
    Slide,
    Video,
)
from inkflow.overlay import Overlay
from inkflow.pdf import PdfPages
from inkflow.steps import StepResolver
from inkflow.svg import (
    compose_overlays,
    compose_with_ancestors,
    duplicate_zone_ids,
    resolve_links,
    theme_generic_fonts,
)
from inkflow.svgio import SvgElement, serialize_svg
from inkflow.themes import Theme
from inkflow.titles import humanize
from inkflow.transitions import Transition
from inkflow.zones import (
    ParsedMarkdown,
    ZoneFill,
    build_slide_content,
    parse_markdown_zones,
)

# ── Slide wire format ────────────────────────────────────────────────────────


class EditableFile(TypedDict):
    label: str
    name: str
    path: str


class EmptyZone(TypedDict):
    """A zone nothing filled. Pruned from the slide, so the editor draws its
    placeholder from this instead."""

    zone: str
    locator: str
    x: float
    y: float
    width: float
    height: float
    transform: str | None


class SlideEditInfo(TypedDict):
    """Pipeline facts only the visual editor needs (``process_deck(editor=True)``)."""

    sources: list[str]
    """Absolute source paths; a ``data-ink`` locator's key indexes this list."""
    emptyZones: list[EmptyZone]
    zoneOrigins: dict[str, str]
    """Filled zone name → where its content was written: ``deck`` (the slide's
    ``zones=``), ``md`` (that zone's own section of the Markdown file) or
    ``md-file`` (several Markdown sections merged into a default zone)."""
    ink: str
    """Absolute path of the slide's ink file, where the editor's pen writes;
    it need not exist yet."""


class SlideSection(TypedDict):
    name: str
    index: int
    """Which section of the deck (``Deck.sections``), so two that share a name
    stay apart."""


class SlideData(TypedDict):
    id: str
    svg: str
    title: str
    notes: str
    editableFiles: list[EditableFile]
    section: NotRequired[SlideSection]
    """The section the slide is in; absent before the first section."""
    edit: NotRequired[SlideEditInfo]


# ── Path conventions ─────────────────────────────────────────────────────────


def _infer_slide_id(slide: Slide) -> str:
    if slide.id:
        return slide.id
    if slide.md is not None and not isinstance(slide.md, Inline):
        return Path(slide.md).stem
    src = Path(slide.src)
    return src.stem if src.suffix else slide.src.replace("/", "-").replace(":", "-")


def _deduplicate_ids(raw_ids: list[str]) -> list[str]:
    """Number repeated ids ``-2``, ``-3``…, skipping any number that is already
    some other slide's own id (``content``, ``content-2``, ``content`` must not
    give two ``content-2``)."""
    taken = set(raw_ids)
    seen: dict[str, int] = {}
    used: set[str] = set()
    result: list[str] = []
    for raw in raw_ids:
        if raw not in used:
            seen.setdefault(raw, 1)
            used.add(raw)
            result.append(raw)
            continue
        n = seen.get(raw, 1) + 1
        while f"{raw}-{n}" in taken or f"{raw}-{n}" in used:
            n += 1
        seen[raw] = n
        used.add(f"{raw}-{n}")
        result.append(f"{raw}-{n}")
    return result


def slide_ids(slides: list[Slide]) -> list[str]:
    """The id each slide is known by (``slide:<id>`` links), in order."""
    return _deduplicate_ids([_infer_slide_id(s) for s in slides])


def _infer_slide_title(
    slide: Slide, slide_id: str, parsed: ParsedMarkdown | None
) -> str:
    if slide.title:
        return slide.title
    if parsed is not None:
        chunks = parsed.zones.get("title", [])
        if chunks and isinstance(chunks[0], str):
            return chunks[0].lstrip("#").strip()
    stem = re.sub(r"^\d+-", "", slide_id)
    return humanize(stem)


def resolve_slide_src(src: str, project_dir: Path, theme: Theme | None = None) -> Path:
    """Resolve a Slide.src string to an absolute Path.

    Single-part names (no directory separator, no scheme prefix) are checked
    against slides/ first: bare names get .svg appended, names that already
    carry an extension are tried as-is. If the slides/ candidate does not
    exist, the 3-level layout search runs (project layouts/ → theme layouts/
    → builtin layouts/). Everything else delegates directly to resolve_parent_path.
    """
    p = Path(src)
    if (
        not p.is_absolute()
        and len(p.parts) == 1
        and not src.startswith(("local:", "theme:", "builtin:", "./", "../"))
    ):
        name = src if p.suffix else src + ".svg"
        slides_candidate = project_dir / "slides" / name
        if slides_candidate.exists():
            return slides_candidate
    return resolve_parent_path(src, project_dir, project_dir, theme)


def resolve_overlay_chains(
    overlays: Sequence[Overlay],
    project_dir: Path | None,
    theme: Theme | None = None,
    base_dir: Path | None = None,
) -> list[list[Path]]:
    """Resolve each overlay to a root-first path list, ``[*ancestors, overlay]``.

    Bare names resolve in the overlay namespace at every level, including an
    overlay's own ``inkflow:parent``, so chrome can only ever inherit chrome.

    ``base_dir`` is what a relative ``src`` is relative to, the project directory
    for the deck's own overlays. Authoring tools resolve an overlay named by a file
    attribute against that file instead, which is also the path that works without
    a project at all.
    """
    base = base_dir if base_dir is not None else project_dir
    if base is None:
        raise ValueError("resolving overlays requires a project directory or base_dir")
    chains: list[list[Path]] = []
    for overlay in overlays:
        path = resolve_parent_path(
            overlay.src, base, project_dir, theme, AssetKind.OVERLAY
        )
        ancestors = resolve_chain(path, project_dir, theme, AssetKind.OVERLAY)
        chains.append([*ancestors, path])
    return chains


# ── Animation / transition serialization ──────────────────────────────────────


def _set_fields(obj: object) -> dict[str, object]:
    """Dataclass fields whose value is not None (None means 'defer to the default')."""
    fields = cast("dict[str, object]", vars(obj))
    return {k: v for k, v in fields.items() if v is not None}


def resolve_steps(cues: list[Cue], base: int = 0) -> list[tuple[Cue, int]]:
    """Pair each cue with its resolved step, walking the sequence in order.

    ``base`` is the starting step — 0, or the markdown-reveal count when this
    list is concatenated after the reveals.
    """
    resolver = StepResolver(base)
    return [(cue, resolver.resolve(cue.trigger)) for cue in cues]


class PlacedCue(NamedTuple):
    """A cue resolved to its concrete step and its offset within that step's run.

    ``offset`` is seconds from the run's start where the cue's slot begins.
    """

    cue: Cue
    step: int
    offset: float


def _resolve_run_offsets(pairs: list[tuple[Cue, int]]) -> list[PlacedCue]:
    """Assign each cue its run ``offset``: where its slot begins within its step's run.

    A step's cues play as one progress-driven run in the presenter. ``offset`` (seconds
    from the run's start) places each cue's slot; the presenter scrubs the cue's own
    ``[0, delay + duration]`` effect timeline starting there, so the authored ``delay``
    still applies.

    The slot is chosen by ``trigger``: ``ON_CLICK`` or a ``Trigger.at`` pin starts a
    fresh group (offset 0); ``WITH_PREVIOUS`` shares its predecessor's slot; and
    ``AFTER_PREVIOUS`` starts when the predecessor finishes (its slot plus its full
    ``delay + duration`` footprint). Non-``Animation`` cues (``PlayVideo``, no timing)
    contribute a zero footprint and their offset is unused.
    """
    prev_offset = 0.0  # slot start of the previous cue within its run
    prev_span = 0.0  # the previous cue's delay + duration footprint
    result: list[PlacedCue] = []
    for cue, step in pairs:
        # Only Animation cues carry timing; a PlayVideo contributes a zero footprint.
        delay = cue.delay if isinstance(cue, Animation) else 0.0
        duration = cue.duration if isinstance(cue, Animation) else 0.0
        if cue.trigger == Trigger.AFTER_PREVIOUS:
            offset = prev_offset + prev_span
        elif cue.trigger == Trigger.WITH_PREVIOUS:
            offset = prev_offset
        else:  # ON_CLICK or a Trigger.at pin: a fresh run
            offset = 0.0
        prev_offset = offset
        prev_span = delay + duration
        result.append(PlacedCue(cue, step, offset))
    return result


# ── Animation cue serialization (`data-cues`) ─────────────────────────────────
# Each animated element carries a `data-cues` JSON array. Each entry pairs a step
# and kind with the keyframe name and the params the step engine needs: `opts` are
# element.animate() playback options (seconds; the engine converts to ms), `vars`
# are ready-to-inject strings the engine substitutes for `var(--anim-<key>)` in the
# keyframes.


def _offset_vector(direction: Direction, distance: float) -> tuple[str, str]:
    """The (x, y) translate offset an element enters from / exits toward, as
    keyframe-ready strings. Left and up are negative; ``px`` == SVG user units."""
    if direction == Direction.LEFT:
        return f"{-distance}px", "0px"
    if direction == Direction.RIGHT:
        return f"{distance}px", "0px"
    if direction == Direction.UP:
        return "0px", f"{-distance}px"
    return "0px", f"{distance}px"  # DOWN


def _cue_entry(anim: Animation, step: int, offset: float) -> dict[str, object]:
    """Serialize one animation cue to a `data-cues` entry.

    The base `Animation` fields are element.animate() ``opts`` (``delay`` included and
    untouched); ``offset`` is where the cue's slot begins in its step's run; slide
    direction/distance resolve to a translate offset; every other (subclass) field
    passes through as a ``var`` keyed by its field name, injected into the keyframes'
    ``var(--anim-<key>)``.
    """
    fields: dict[str, object] = {
        k: v
        for k, v in cast("dict[str, object]", vars(anim)).items()
        if k not in ("element", "trigger") and v is not None
    }
    # element.animate() options (durations in seconds; the engine scales to ms).
    opts: dict[str, object] = {
        "duration": fields.pop("duration"),
        "delay": fields.pop("delay"),
        "easing": fields.pop("easing"),
        "iterations": fields.pop("iterations"),
    }

    # Substitution values injected into the keyframes' `var(--anim-<key>)`. A slide's
    # direction+distance together resolve to a translate offset (the per-direction sign
    # is geometry CSS can't derive from an enum). Every other field, including a lone
    # `distance` like Bounce's rise, passes through as a plain var; a keyframe applies
    # any unit it needs, e.g. `calc(var(--anim-distance) * 1px)`.
    substitutions: dict[str, str] = {}
    if "direction" in fields and "distance" in fields:
        substitutions["from-x"], substitutions["from-y"] = _offset_vector(
            cast("Direction", fields.pop("direction")),
            cast("float", fields.pop("distance")),
        )
    for name, value in fields.items():
        substitutions[name] = str(value)

    return {
        "step": step,
        "kind": anim.kind.value,
        "name": anim.slug(),
        "offset": offset,
        "opts": opts,
        "vars": substitutions,
    }


def _add_class(el: SvgElement, cls: str) -> None:
    existing = [c for c in el.get("class", "").split() if c]
    if cls not in existing:
        el.set("class", " ".join([*existing, cls]))


def _starts_hidden(entries: list[dict[str, object]]) -> bool:
    """True when the element's first visibility cue (lowest step) is an enter, so it
    is hidden before that cue fires. Drives the initial-hidden guard that prevents a
    flash of the element before the engine attaches."""
    for e in entries:  # pre-sorted by step
        if e["kind"] == AnimationKind.ENTER.value:
            return True
        if e["kind"] == AnimationKind.EXIT.value:
            return False
    return False


def _warn_duplicate_kinds(element_id: str, entries: list[dict[str, object]]) -> None:
    """Warn on two enters (or two exits) with no opposing cue between them: the second
    re-plays a state the element is already in, almost always a mistake. Emphasis cues
    may repeat freely and are ignored."""
    last: object = None
    for e in entries:
        kind = e["kind"]
        if kind == AnimationKind.EMPHASIS.value:
            continue
        if kind == last:
            logger.warning(
                f"element #{element_id}: two {kind} animations with no opposing "
                + "cue between them"
            )
        last = kind


def _annotate_play_video(root: SvgElement, cue: PlayVideo, step: int) -> None:
    zone_id = f"zone-{cue.element}"
    zone = root.find(f'.//*[@id="{zone_id}"]')
    video = zone.find(f".//{{{ns.XHTML}}}video") if zone is not None else None
    if video is None:
        logger.warning(f"PlayVideo target #{zone_id} has no video in SVG")
        return
    video.set("data-play-on-step", str(step))


def annotate_svg(root: SvgElement, cues: list[tuple[Cue, int]]) -> SvgElement:
    """Annotate the SVG for the step engine: `PlayVideo` cues stamp
    `data-play-on-step`; animation cues are grouped per target element into one
    `data-cues` JSON list (sorted by step).

    ``cues`` are in timeline order, so the per-cue run ``offset`` (which cue's slot
    begins where within its step's run) is resolved here before grouping."""
    entries_by_element: dict[str, list[dict[str, object]]] = {}
    for cue, step, offset in _resolve_run_offsets(cues):
        if isinstance(cue, PlayVideo):
            _annotate_play_video(root, cue, step)
        elif isinstance(cue, Animation):
            entries_by_element.setdefault(cue.element, []).append(
                _cue_entry(cue, step, offset)
            )
        else:
            logger.warning(f"cue with no annotation handler: {type(cue).__name__}")

    for element_id, entries in entries_by_element.items():
        el = root.find(f'.//*[@id="{element_id}"]')
        if el is None:
            logger.warning(f"element #{element_id} not found in SVG")
            continue
        entries.sort(key=lambda e: cast("int", e["step"]))
        _warn_duplicate_kinds(element_id, entries)
        el.set("data-cues", json.dumps(entries, separators=(",", ":")))
        # An `anim-<slug>` class per cue type: a pure styling hook (the engine drives
        # animation from `data-cues`). Built-in CSS uses it only for constant styles a
        # keyframe cannot hold at the right cascade origin (scale's transform-box);
        # custom animations can hook their own static styles the same way.
        for name in dict.fromkeys(cast("str", e["name"]) for e in entries):
            _add_class(el, f"anim-{name}")
        if _starts_hidden(entries):
            _add_class(el, "anim-pending")
    return root


def _serialize_transition(t: Transition) -> dict[str, object]:
    return {"type": t.slug(), **_set_fields(t)}


def resolve_transitions(deck: Deck) -> list[dict[str, object]]:
    default = deck.effective_transition
    return [
        _serialize_transition(
            slide.transition if slide.transition is not None else default
        )
        for slide in deck.slides
        if slide.visible
    ]


_KEYFRAMES_RE = re.compile(r"@(?:(?:-webkit-)?keyframes|font-face)\b")


def _extract_keyframes(css: str) -> tuple[str, str]:
    """Split top-level ``@keyframes`` and ``@font-face`` blocks out of ``css``.

    Returns ``(keyframes_css, remaining_css)``. Animation names are document-global,
    and the step engine discovers custom ``@keyframes`` (from ``Deck(style=...)``) by
    name, so they must stay unscoped — wrapping them in ``@scope`` would hide or
    invalidate them. An ``@font-face`` (an SVG that carries its own font, such as
    the demo's logo) is not allowed inside ``@scope`` either. The rest of the CSS
    is still scoped by the caller.
    """
    keyframes: list[str] = []
    rest: list[str] = []
    pos = 0
    for m in _KEYFRAMES_RE.finditer(css):
        brace = css.find("{", m.end())
        if brace == -1:
            continue
        depth, j = 0, brace
        while j < len(css):
            if css[j] == "{":
                depth += 1
            elif css[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        end = j + 1
        rest.append(css[pos : m.start()])
        keyframes.append(css[m.start() : end])
        pos = end
    rest.append(css[pos:])
    return "\n".join(keyframes), "".join(rest)


def _scope_slide_styles(root: SvgElement, slide_number: int) -> SvgElement:
    """Assign a unique ID to the SVG root and wrap any inline <style> in @scope.

    SVG style blocks would bleed onto adjacent slides during CSS transitions without
    this guard. ``@keyframes`` are lifted out first and kept global so the step engine
    can still find them by name.
    """
    slide_id = f"inkflow-slide-{slide_number}"
    root.set("id", slide_id)
    for style_el in root.findall(f".//{{{ns.SVG}}}style"):
        css = style_el.text
        if not css or not css.strip():
            continue
        keyframes_css, rest = _extract_keyframes(css)
        scoped = f"@scope(#{slide_id}) {{\n{rest}\n}}" if rest.strip() else ""
        style_el.text = "\n".join(filter(None, [keyframes_css, scoped]))
    return root


def _add_layout_classes(
    root: SvgElement,
    chain: list[Path],
    src: Path,
    overlay_chains: list[list[Path]],
) -> SvgElement:
    """Add layout-<stem> and overlay-<stem> classes to the SVG root.

    This scopes CSS rules in styles.css to a slide type
    (e.g. `.layout-cover #zone-title`). Every entry of an overlay's chain gets a
    class, not just the leaf, so `.overlay-brand .rule` matches whichever variant
    of that chrome is in play.
    """
    prefixes = ("layout-", "overlay-")
    existing = [c for c in root.get("class", "").split() if not c.startswith(prefixes)]
    layout_classes = [f"layout-{p.stem}" for p in [*chain, src]]
    overlay_classes = [
        f"overlay-{p.stem}" for overlay in overlay_chains for p in overlay
    ]
    root.set("class", " ".join(existing + layout_classes + overlay_classes))
    return root


# ── Per-slide pipeline ────────────────────────────────────────────────────────


class SourceTable:
    """The files one slide is composed from, in first-read order.

    A file's position is the key its ``data-ink`` locators carry, so the editor
    can name a file with a small integer on every element.
    """

    def __init__(self) -> None:
        self.paths: list[Path] = []

    def key(self, path: Path) -> int:
        if path not in self.paths:
            self.paths.append(path)
        return self.paths.index(path)

    def stamp(self, path: Path) -> Callable[[SvgElement], None]:
        return stamper(self.key(path))


@dataclass
class SlideSvg:
    """A slide's SVG tree as it moves through the per-slide pipeline.

    Each method mutates the tree in place (like ``list.sort()``) and returns ``None``;
    the DOM work is delegated to the content/svg modules, which take and return the root
    element. This keeps the pipeline a single parse and a single serialize with a
    readable sequence of commands in ``process_slide``.
    """

    root: SvgElement
    src: Path
    """The file the slide was read from. Kept because a relative reference inside
    the tree resolves against it, and because the layout tagging needs it later."""

    sources: SourceTable | None = None
    """Set when the editor needs provenance: every file read is stamped."""

    @classmethod
    def read(
        cls, src: Path, roots: AssetRoots, sources: SourceTable | None = None
    ) -> SlideSvg:
        stamp = sources.stamp(src) if sources is not None else None
        return cls(read_resolved_svg(src, roots, stamp), src, sources)

    def _read(self, path: Path, roots: AssetRoots) -> SvgElement:
        stamp = self.sources.stamp(path) if self.sources is not None else None
        return read_resolved_svg(path, roots, stamp)

    def compose_ancestors(self, chain: list[Path], roots: AssetRoots) -> None:
        if chain:
            self.root = compose_with_ancestors(
                self.root, [self._read(path, roots) for path in chain]
            )

    def compose_overlays(
        self, overlay_chains: list[list[Path]], roots: AssetRoots
    ) -> None:
        if overlay_chains:
            self.root = compose_overlays(
                self.root,
                [
                    [self._read(path, roots) for path in chain]
                    for chain in overlay_chains
                ],
            )

    def picture_backgrounds(self) -> None:
        self.root = picture_backgrounds(self.root)

    def compose_ink(self, path: Path, roots: AssetRoots, slide_id: str) -> None:
        if not path.is_file():
            return
        try:
            ink = self._read(path, roots)
        except ValueError as exc:
            # A broken ink file loses the drawing, never the slide.
            logger.warning(f"{slide_id}: ink not shown: {exc}")
            return
        self.root = compose_ink(self.root, ink)

    def inline_diagrams(self, roots: AssetRoots) -> None:
        register = self.sources.key if self.sources is not None else None
        self.root = inline_diagrams(self.root, roots, register)

    def empty_zones(self) -> list[EmptyZone]:
        zones: list[EmptyZone] = []
        for el in unreferenced_zones(self.root):
            x, y, width, height = zone_box(el)
            zones.append(
                {
                    "zone": (el.get("id") or "").removeprefix("zone-"),
                    "locator": el.get(INK, ""),
                    "x": x,
                    "y": y,
                    "width": width,
                    "height": height,
                    "transform": el.get("transform"),
                }
            )
        return zones

    def tag_layout(self, chain: list[Path], overlay_chains: list[list[Path]]) -> None:
        self.root = _add_layout_classes(self.root, chain, self.src, overlay_chains)

    def number_slides(self, slide_number: int, total: int) -> None:
        self.root = substitute_zone_numbers(self.root, slide_number, total)

    def zone_ids(self) -> set[str]:
        return {
            eid
            for el in self.root.iter()
            if (eid := el.get("id")) is not None and eid.startswith("zone-")
        }

    def duplicate_zone_ids(self) -> list[str]:
        return duplicate_zone_ids(self.root)

    def inject_content(
        self,
        content: dict[str, ZoneFill],
        font_size: int,
        dark_mode: bool,
        chart_scale: float = ZONE_TEXT_SCALE,
    ) -> None:
        self.root = substitute_content(
            self.root, content, font_size, dark_mode, chart_scale
        )

    def convert_pdfs(self, pages: PdfPages) -> None:
        self.root = pages.apply(self.root)

    def annotate(self, cues: list[tuple[Cue, int]]) -> None:
        self.root = annotate_svg(self.root, cues)

    def add_style(self, css: str) -> None:
        self.root = inject_style(self.root, css)

    def prune_zones(self) -> None:
        self.root = remove_unreferenced_zones(self.root)

    def resolve_links(self) -> None:
        self.root = resolve_links(self.root)

    def theme_generic_fonts(self) -> None:
        self.root = theme_generic_fonts(self.root)

    def scope_styles(self, slide_number: int) -> None:
        self.root = _scope_slide_styles(self.root, slide_number)

    def to_svg(self) -> str:
        return serialize_svg(self.root)


@dataclass(frozen=True)
class DeckContext:
    """Loop-invariant deck params, built once per rebuild and shared by every slide."""

    project_dir: Path
    theme: Theme
    assets: AssetRoots
    deck_style: str
    font_size: int  # deck default; a slide may override via Slide.font_size
    overlays: Sequence[Overlay]  # deck default, already resolved against the theme
    mode: ColorMode
    total_slides: int
    pdf_pages: PdfPages
    """Converts the PDF pictures (and reports a missing converter once)."""
    chart_scale: float = ZONE_TEXT_SCALE
    """A chart's text size relative to the body text (`PageSize.chart_text_scale`)."""
    editor: bool = False
    """Stamp provenance and collect ``SlideEditInfo`` for the visual editor."""


def _resolve_autoplay_conflicts(
    content: dict[str, ZoneFill], cues: list[Cue]
) -> dict[str, ZoneFill]:
    """Drop ``autoplay`` from a video that a ``PlayVideo`` cue also targets.

    Autoplay and a step cue are contradictory playback triggers; the cue wins.
    Suppressing autoplay here (before injection) rather than stripping the DOM
    attribute later also makes ``Muted.AUTO`` resolve to *unmuted*, so the
    gesture-triggered clip is audible.
    """
    play_targets = {f"zone-{c.element}" for c in cues if isinstance(c, PlayVideo)}
    if not play_targets:
        return content
    result = dict(content)
    for zone_id in play_targets:
        item = result.get(zone_id)
        if isinstance(item, Video) and item.autoplay:
            key = zone_id.removeprefix("zone-")
            logger.warning(f"video in zone {key}: autoplay overridden by PlayVideo cue")
            result[zone_id] = replace(item, autoplay=False)
    return result


class ProcessedSlide(NamedTuple):
    svg: str
    notes: str
    """The slide's markdown-derived notes."""
    edit: SlideEditInfo | None
    """Editor facts, when ``DeckContext.editor`` is set."""


def zone_origin(
    name: str,
    slide: Slide,
    parsed: ParsedMarkdown | None,
    zone_ids: set[str],
    default_zone: str,
) -> str:
    """Where a zone's content is written: ``deck`` (``zones={...}``), ``md``
    (its section of the slide's Markdown) or ``md-file`` (the whole file, shown
    in the default zone because the slide has no zone its headings name)."""
    if name in slide.zones:
        return "deck"
    displaced = parsed is not None and any(
        auto in parsed.auto_zones and f"zone-{auto}" not in zone_ids
        for auto in ("title", "subtitle", "content")
    )
    return "md-file" if displaced and name == default_zone else "md"


def _zone_origins(
    filled: set[str],
    slide: Slide,
    parsed: ParsedMarkdown | None,
    zone_ids: set[str],
    default_zone: str,
) -> dict[str, str]:
    """Where each filled zone's content was written (see ``SlideEditInfo``)."""
    return {
        name: zone_origin(name, slide, parsed, zone_ids, default_zone)
        for name in (zone_id.removeprefix("zone-") for zone_id in filled)
    }


def process_slide(
    slide: Slide,
    ctx: DeckContext,
    slide_number: int,
    parsed: ParsedMarkdown | None,
    md_source: AssetSource,
    slide_id: str,
) -> ProcessedSlide:
    """Return the processed SVG string, markdown-derived notes and editor facts."""
    src = resolve_slide_src(slide.src, ctx.project_dir, ctx.theme)
    chain = resolve_chain(src, ctx.project_dir, ctx.theme)
    overlays = slide.overlays if slide.overlays is not None else ctx.overlays
    overlay_chains = resolve_overlay_chains(overlays, ctx.project_dir, ctx.theme)

    sources = SourceTable() if ctx.editor else None
    zone_origins: dict[str, str] = {}
    doc = SlideSvg.read(src, ctx.assets, sources)
    doc.compose_ancestors(chain, ctx.assets)
    doc.compose_overlays(overlay_chains, ctx.assets)
    # Above the overlays (it was drawn on the slide as shown), and before
    # annotation, so a cue can reveal a stroke like any other element.
    ink = ink_path(slide, slide_id, ctx.project_dir)
    doc.compose_ink(ink, ctx.assets, slide_id)
    # Before annotation, so animations can target a diagram's shapes.
    doc.inline_diagrams(ctx.assets)
    doc.picture_backgrounds()
    for zone_id in doc.duplicate_zone_ids():
        logger.warning(
            f"{slide_id}: {zone_id} is declared more than once after composition — "
            + "zone ids must be unique across a slide and its overlays"
        )
    doc.tag_layout(chain, overlay_chains)
    doc.theme_generic_fonts()
    doc.number_slides(slide_number, ctx.total_slides)

    md_notes = ""
    reveal_pairs: list[tuple[Cue, int]] = []
    reveal_max = 0
    font_size = slide.font_size if slide.font_size is not None else ctx.font_size
    if parsed is not None or slide.zones:
        zone_ids = doc.zone_ids()
        default_zone = resolve_default_zone(doc.root, zone_ids)
        result = build_slide_content(
            parsed,
            slide.zones,
            md_source,
            AssetSource.for_deck(ctx.assets),
            available_zones=zone_ids,
            default_zone=default_zone,
            chart_font=fence_font(font_size, ctx.chart_scale),
        )
        md_notes = result.notes
        reveal_pairs = [(anim, step) for anim, step in result.animations]
        reveal_max = result.max_step
        if sources is not None:
            zone_origins = _zone_origins(
                set(result.content), slide, parsed, zone_ids, default_zone
            )
        if result.content:
            content = _resolve_autoplay_conflicts(result.content, slide.animations)
            doc.inject_content(
                content, font_size, ctx.mode == ColorMode.DARK, ctx.chart_scale
            )
    # After injection, so a PDF in a zone or in Markdown is converted as well.
    doc.convert_pdfs(ctx.pdf_pages)

    # The deck animations=[...] list continues the timeline after the markdown
    # reveals (steps 1..reveal_max), so the two form one continuous count.
    deck_pairs = resolve_steps(slide.animations, base=reveal_max)
    cue_pairs = reveal_pairs + deck_pairs
    if cue_pairs:
        doc.annotate(cue_pairs)

    slide_style_css = load_style(slide.extra_style, ctx.project_dir)
    combined_css = "\n".join(filter(None, [ctx.deck_style, slide_style_css]))
    if combined_css:
        doc.add_style(combined_css)

    edit: SlideEditInfo | None = None
    if sources is not None:
        edit = {
            "sources": [str(p) for p in sources.paths],
            "emptyZones": doc.empty_zones(),
            "zoneOrigins": zone_origins,
            "ink": str(ink),
        }
    doc.prune_zones()
    doc.resolve_links()
    doc.scope_styles(slide_number)
    return ProcessedSlide(doc.to_svg(), md_notes, edit)


@cache
def _installed_package_roots() -> tuple[Path, ...]:
    """Directories holding installed packages: a venv's or the system's site-packages.

    Used to tell dependency code (e.g. a theme bundled with ``pip``-installed
    inkflow) apart from authored project content, even when the venv itself
    lives inside the project directory (``uv``'s default ``.venv`` layout) —
    so the check doesn't depend on guessing the venv's directory name.
    """
    roots = {
        sysconfig.get_path("purelib"),
        sysconfig.get_path("platlib"),
        *site.getsitepackages(),
        site.getusersitepackages(),
    }
    return tuple(Path(root).resolve() for root in roots if root)


def _is_project_file(path: Path, project_dir: Path) -> bool:
    """Whether path is authored project content, not dependency code installed
    inside it (e.g. a venv nested under the project directory)."""
    return path.is_relative_to(project_dir) and not any(
        path.is_relative_to(root) for root in _installed_package_roots()
    )


def _source_for(roots: AssetRoots, path: Path | None) -> AssetSource:
    """Asset source for loaded text: its own file, or deck.py for ``Inline``."""
    if path is None:
        return AssetSource.for_deck(roots)
    return AssetSource.for_file(roots, path)


def _editable_files(
    ctx: DeckContext,
    svg_path: Path,
    md: LoadedText | None,
    loaded_notes: LoadedText,
    deck_path: Path,
) -> list[EditableFile]:
    """The slide's in-project ancestor layouts (root first, so the immediate
    parent sits next to the slide's own SVG), that SVG itself, any file-backed
    content/notes, and the deck script itself: what the presenter's Edit button
    offers. ``deck_path`` is always present, so this list is never a single entry
    — every slide's own SVG plus its deck script is the floor.

    A theme/built-in ancestor is skipped: it lives outside the project (often
    inside an installed package — including one installed into a venv nested
    under the project directory), so editing it is unlikely to be wanted and may
    not even be writable.
    """
    files: list[EditableFile] = []
    chain = resolve_chain(svg_path, ctx.project_dir, ctx.theme)
    for parent in chain:
        if _is_project_file(parent, ctx.project_dir):
            files.append({"label": "Parent", "name": parent.name, "path": str(parent)})
    files.append({"label": "Layout", "name": svg_path.name, "path": str(svg_path)})
    if md is not None and md.path is not None:
        files.append({"label": "Content", "name": md.path.name, "path": str(md.path)})
    if loaded_notes.path is not None:
        files.append(
            {
                "label": "Notes",
                "name": loaded_notes.path.name,
                "path": str(loaded_notes.path),
            }
        )
    files.append({"label": "Deck", "name": deck_path.name, "path": str(deck_path)})
    return files


def deck_context(
    deck: Deck, project_dir: Path, total_slides: int, *, editor: bool = False
) -> DeckContext:
    """The per-build parameters every slide of ``deck`` is processed with."""
    assets = AssetRoots(project_dir, deck.theme.asset_dir())
    return DeckContext(
        project_dir=project_dir,
        theme=deck.theme,
        assets=assets,
        deck_style=load_style(deck.style, project_dir),
        font_size=deck.effective_font_size,
        overlays=deck.effective_overlays,
        mode=deck.effective_mode,
        total_slides=total_slides,
        pdf_pages=PdfPages(assets),
        chart_scale=deck.effective_size.chart_text_scale,
        editor=editor,
    )


def process_deck(
    deck: Deck, project_dir: Path, deck_path: Path, *, editor: bool = False
) -> list[SlideData]:
    visible_slides = [s for s in deck.slides if s.visible]
    ctx = deck_context(deck, project_dir, len(visible_slides), editor=editor)
    assets = ctx.assets
    ids = slide_ids(visible_slides)
    sections = {
        id(deck.slides[i]): k
        for k, span in enumerate(deck.section_ranges())
        for i in span
    }
    results: list[SlideData] = []
    for i, (slide, slide_id) in enumerate(zip(visible_slides, ids, strict=True)):
        logger.debug(f"processing slide {i + 1}/{len(visible_slides)}: {slide_id}")
        md = load_md(slide.md, project_dir)
        parsed = parse_markdown_zones(md.text) if md is not None else None
        title = _infer_slide_title(slide, slide_id, parsed)
        loaded_notes = load_notes(slide.notes, project_dir)
        explicit_notes = _source_for(assets, loaded_notes.path).html(loaded_notes.text)
        md_source = _source_for(assets, md.path if md is not None else None)
        processed = process_slide(slide, ctx, i + 1, parsed, md_source, slide_id)
        notes = "\n".join(filter(None, [explicit_notes, processed.notes]))

        svg_path = resolve_slide_src(slide.src, ctx.project_dir, ctx.theme)
        editable_files = _editable_files(ctx, svg_path, md, loaded_notes, deck_path)

        data: SlideData = {
            "id": slide_id,
            "svg": processed.svg,
            "title": title,
            "notes": notes,
            "editableFiles": editable_files,
        }
        section = sections.get(id(slide))
        if section is not None:
            data["section"] = {"name": deck.sections[section].name, "index": section}
        if processed.edit is not None:
            data["edit"] = processed.edit
        results.append(data)
    logger.info(f"processed {len(results)} slide(s)")
    return results
